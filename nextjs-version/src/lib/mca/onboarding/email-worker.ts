import "server-only";
import { z } from "zod";
import { getDatabase, newId, nowIso, withTransaction, type DbExecutor } from "../db";
import { createOpaqueToken, decryptSensitive, encryptSensitive, hashOpaqueToken, hmacScopedToken } from "../crypto";
import { AppError } from "../errors";
import { evaluateCompanyAccess, getCompanyAccess } from "../company-access";
import { parseEmailAddress } from "../intake/usesend";
import type { EnrollmentRecord, OnboardingEmailPurpose, OnboardingEmailState } from "./contracts";
import type { EnrollmentChallengePayload } from "./auth";
import { onboardingEmailEnabled } from "./config";
import { ONBOARDING_EMAIL_TEMPLATE_VERSIONS, onboardingEmailEncryptionScope } from "./email-intents";
import { enrollmentChallengeScope, enrollmentEmailHash, findEnrollment, newOwnerEnrollment } from "./store";
import { renderOnboardingEmail } from "./email-content";
import { readVerifiedEnrollmentBilling } from "./evidence";
import { dispatchOnboardingEmail, onboardingEmailConfiguration, onboardingEmailProviderIdentity, type FrozenOnboardingEmailConfiguration, type OnboardingEmailDispatchOutcome } from "./email-transport";

interface EmailRow {
  id: string; enrollment_id: string; generation: number; purpose: OnboardingEmailPurpose;
  delivery_key: string; payload_cipher: string; payload_hash: string; recipient_hash: string;
  recipient_cipher: string | null; content_cipher: string | null; provider_config_cipher: string | null;
  template_version: number; provider: string | null; provider_account_id: string | null; frozen_at: string | null;
  state: OnboardingEmailState; attempts: number; claim_token: string | null; lease_until: string | null;
  superseded_by_generation: number | null;
}
const payloadSchema = z.object({ version: z.literal(1), enrollmentId: z.string(), generation: z.number().int().positive(), purpose: z.enum(["business_information_requested", "getting_started"]), email: z.email(), trialEndsAt: z.iso.datetime({ offset: true }) }).strict();
const contentSchema = z.object({ subject: z.string().min(1).max(200), text: z.string().min(1), html: z.string().min(1) }).strict();
const configurationFields = { replyTo: z.string().refine(value => Boolean(parseEmailAddress(value))).nullable(), endpoint: z.url().refine(value => new URL(value).protocol === "https:"), keyIdentity: z.string().min(1).max(128) };
const configurationSchema = z.union([
  z.object({ provider: z.enum(["usesend", "resend"]), from: z.string().min(1), ...configurationFields }).strict(),
  z.object({ provider: z.literal("webhook"), from: z.string().nullable(), ...configurationFields }).strict(),
]);
const safeCode = (value?: string) => value && /^[a-z0-9_]{1,80}$/.test(value) ? value : "onboarding_email_preflight_failed";
const scope = (row: EmailRow) => onboardingEmailEncryptionScope(row.enrollment_id, row.generation);
const afterMinutes = (clock: string, minutes: number) => new Date(Date.parse(clock) + minutes * 60000).toISOString();

async function leasedRow(db: DbExecutor, id: string, token: string, clock: string) {
  const row = await db.queryOne<EmailRow>("SELECT * FROM mca_onboarding_service_emails WHERE id=? AND state='sending' AND claim_token=? AND lease_until>? AND lease_until::timestamptz>clock_timestamp() FOR UPDATE", [id, token, clock]);
  // A lock wait may outlive the clock used to select the row.
  return row && row.lease_until && Date.parse(row.lease_until) > Date.now() ? row : undefined;
}

async function eligibility(db: DbExecutor, row: EmailRow) {
  const enrollment = await findEnrollment(row.enrollment_id, db);
  // A parked getting_started row (above the current generation) is a pending email change or a fresh link; only the latest is live.
  const parked = enrollment && row.purpose === "getting_started" && row.generation > enrollment.emailGeneration;
  if (!enrollment?.activatedAt || enrollment.checkoutState !== "complete" || row.superseded_by_generation
    || (parked
      ? !newOwnerEnrollment(enrollment) || await db.queryOne("SELECT 1 FROM mca_onboarding_service_emails WHERE enrollment_id=? AND generation>? LIMIT 1", [row.enrollment_id, row.generation])
      : enrollment.emailGeneration !== row.generation || enrollment.emailHash !== row.recipient_hash)) throw new AppError(409, "onboarding_email_superseded", "The email intent is no longer current.");
  if (enrollment.billingState === "blocked" || ["canceling", "canceled", "uncertain", "operator_required"].includes(enrollment.recoveryState)) throw new AppError(409, "onboarding_email_suppressed", "The enrollment requires recovery review.");
  let access;
  if (enrollment.workspaceId) {
    // After finalization, the company projection is updated independently of the enrollment.
    access = await getCompanyAccess(enrollment.workspaceId);
  } else {
    const evidence = await readVerifiedEnrollmentBilling(enrollment.id, db);
    if (!evidence || evidence.accountId !== enrollment.providerAccountId || evidence.livemode !== enrollment.offer.livemode || evidence.sessionId !== enrollment.checkoutSessionId || evidence.customerId !== enrollment.customerId || evidence.subscriptionId !== enrollment.subscriptionId || evidence.requestGeneration !== enrollment.checkoutGeneration || evidence.trialStartedAt !== enrollment.trialStartedAt || evidence.trialEndsAt !== enrollment.trialEndsAt || evidence.entitlement.status !== enrollment.billingState) throw new AppError(409, "onboarding_email_suppressed", "Verified current enrollment billing is required.");
    const periodEnd = enrollment.billingState === "trialing" && evidence.entitlement.periodEnd && enrollment.trialEndsAt
      ? new Date(Math.min(Date.parse(evidence.entitlement.periodEnd), Date.parse(enrollment.trialEndsAt))).toISOString()
      : evidence.entitlement.periodEnd;
    access = evaluateCompanyAccess({ state_present: 1, legacy_exempt: 0, trial_ends_at: null, manual_paused: 0, access_extended_until: null, grace_ends_at: evidence.graceEndsAt, processing_extension_until: evidence.processingExtensionUntil, pending_seats: null, status: evidence.entitlement.status, period_end: periodEnd, seat_limit: evidence.entitlement.seatLimit });
  }
  if (!access.allowed || (access.status === "trialing" && (!enrollment.trialEndsAt || Date.parse(enrollment.trialEndsAt) <= Date.now()))) throw new AppError(409, "onboarding_email_suppressed", "The current billing lifecycle does not permit onboarding email.");
  // Safety blocks apply to the address across configuration changes; merchant consent is unrelated.
  if (await db.queryOne("SELECT recipient_hash FROM mca_service_email_suppressions WHERE recipient_hash=? AND active=true LIMIT 1", [row.recipient_hash])) throw new AppError(409, "onboarding_email_suppressed", "Service email delivery to this address is suppressed.");
  return enrollment;
}

async function claim(clock: string): Promise<EmailRow | undefined> {
  return withTransaction(async db => {
    const row = await db.queryOne<EmailRow>("SELECT * FROM mca_onboarding_service_emails WHERE state IN ('queued','retry') AND next_attempt_at<=? AND attempts<3 ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED", [clock]);
    if (!row) return;
    const operationClock = nowIso(), token = newId();
    return db.queryOne<EmailRow>("UPDATE mca_onboarding_service_emails SET state='sending',claim_token=?,lease_until=?,updated_at=? WHERE id=? AND state=? AND claim_token IS NULL RETURNING *", [token, afterMinutes(operationClock, 2), operationClock, row.id, row.state]);
  });
}

/** A killed sending marker cannot prove nonacceptance. Compare the exact expired token and lease. */
async function expireClaims(clock: string) {
  return withTransaction(async db => {
    const rows = (await db.query<EmailRow>("SELECT * FROM mca_onboarding_service_emails WHERE state='sending' AND lease_until<=? ORDER BY lease_until,id LIMIT 100 FOR UPDATE SKIP LOCKED", [clock])).rows;
    let expired = 0;
    for (const row of rows) expired += await db.execute("UPDATE mca_onboarding_service_emails SET state='uncertain',error_code='onboarding_email_interrupted',claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='sending' AND claim_token=? AND lease_until=? AND lease_until<=?", [clock, row.id, row.claim_token, row.lease_until, clock]);
    // No provider/operator receipt is invented for a local lease timeout.
    return expired;
  });
}

async function freeze(row: EmailRow): Promise<EmailRow | undefined> {
  return withTransaction(async db => {
    // Enrollment before email row, like every invite writer (they hold FOR UPDATE), so a minted invite is always
    // visible to their revocation; KEY SHARE does not block ordinary billing updates.
    await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR KEY SHARE", [row.enrollment_id]);
    const clock = nowIso(), live = await leasedRow(db, row.id, row.claim_token!, clock);
    if (!live) return;
    const enrollment = await eligibility(db, live);
    // Checked before the frozen short-circuit: an older snapshot is never re-sent as current copy.
    if (live.template_version !== ONBOARDING_EMAIL_TEMPLATE_VERSIONS[live.purpose]) throw new AppError(409, "onboarding_email_template_unavailable", "Review the service email template version.");
    if (live.frozen_at) return live;
    const payload = payloadSchema.parse(JSON.parse(decryptSensitive(live.payload_cipher, scope(live))));
    if (payload.enrollmentId !== live.enrollment_id || payload.generation !== live.generation || payload.purpose !== live.purpose || payload.trialEndsAt !== enrollment.trialEndsAt || enrollmentEmailHash(payload.email) !== live.recipient_hash || hmacScopedToken("onboarding-email-payload", live.enrollment_id, JSON.stringify(payload)) !== live.payload_hash) throw new AppError(409, "onboarding_email_payload_changed", "Review the service email intent.");
    const configuration = onboardingEmailConfiguration();
    // Only a brand-new owner gets a password invite; existing accounts already have a sign-in path.
    const invite = payload.purpose === "getting_started" && newOwnerEnrollment(enrollment)
      ? { challengeId: newId(), token: createOpaqueToken() } : undefined;
    // A parked row to another address is a pending email change; the minted challenge becomes its source of truth.
    const emailChange = live.generation > enrollment.emailGeneration && live.recipient_hash !== enrollment.emailHash;
    let content: ReturnType<typeof renderOnboardingEmail>;
    try { content = renderOnboardingEmail({ purpose: payload.purpose, enrollmentId: payload.enrollmentId, generation: payload.generation, trialEndsAt: payload.trialEndsAt, origin: process.env.MCA_APP_ORIGIN?.trim() ?? "", ...(invite ? { invite } : {}) }); }
    catch { throw new AppError(503, "onboarding_email_origin_invalid", "Configure a secure onboarding application origin."); }
    const writeClock = nowIso();
    const frozen = await db.queryOne<EmailRow>("UPDATE mca_onboarding_service_emails SET recipient_cipher=?,content_cipher=?,provider_config_cipher=?,provider=?,provider_account_id=?,frozen_at=?,updated_at=? WHERE id=? AND state='sending' AND claim_token=? AND lease_until>? AND lease_until::timestamptz>clock_timestamp() AND frozen_at IS NULL RETURNING *", [encryptSensitive(payload.email, scope(live)), encryptSensitive(JSON.stringify(content), scope(live)), encryptSensitive(JSON.stringify(configuration), scope(live)), configuration.provider, onboardingEmailProviderIdentity(configuration), writeClock, writeClock, live.id, live.claim_token, writeClock]);
    // Minted once, only with the snapshot that carries it; frozen retries return above and never mint again.
    // A change invite returns the generation the enrollment moves to; any other invite returns the current one.
    if (frozen && invite) await insertInvite(db, enrollment, payload, invite, writeClock, emailChange ? live.generation : enrollment.emailGeneration, emailChange);
    return frozen;
  });
}

/** The DB keeps only the token hash; the CHECK caps expiry at created_at + 1 day, so both derive from one clock. */
async function insertInvite(db: DbExecutor, enrollment: EnrollmentRecord, payload: z.infer<typeof payloadSchema>, invite: { challengeId: string; token: string }, now: string, generation: number, emailChange: boolean) {
  const challenge: EnrollmentChallengePayload = { version: 1, email: payload.email.trim().toLowerCase(), emailGeneration: enrollment.emailGeneration, destination: "crm", generation, issuedAt: now, sessionId: null, invite: true, ...(emailChange ? { emailChange: true as const } : {}) };
  await db.execute("INSERT INTO mca_enrollment_challenges(id,enrollment_id,purpose,token_hash,email_cipher,email_hash,resume_generation,expires_at,created_at,updated_at) VALUES (?,?,'authentication',?,?,?,?,?,?,?)", [invite.challengeId, enrollment.id, hashOpaqueToken(invite.token), encryptSensitive(JSON.stringify(challenge), enrollmentChallengeScope(invite.challengeId)), enrollmentEmailHash(payload.email), enrollment.resumeGeneration, new Date(Date.parse(now) + 86_400_000).toISOString(), now, now]);
}

/** Configuration failures before a frozen send keep durable work without consuming a provider attempt. */
async function deferUnconfigured(row: EmailRow, code: string): Promise<boolean> {
  const clock = nowIso();
  return Boolean(await getDatabase().execute("UPDATE mca_onboarding_service_emails SET state=?,next_attempt_at=?,error_code=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='sending' AND claim_token=? AND lease_until>? AND lease_until::timestamptz>clock_timestamp() AND frozen_at IS NULL", [row.attempts ? "retry" : "queued", afterMinutes(clock, 15), safeCode(code), clock, row.id, row.claim_token, clock]));
}

/** Called immediately by the transport before its POST, outside all network transactions. */
async function beforeSend(row: EmailRow) {
  await withTransaction(async db => {
    const clock = nowIso(), live = await leasedRow(db, row.id, row.claim_token!, clock);
    if (!live) throw new AppError(409, "onboarding_email_lease_lost", "The email dispatch lease is no longer live.");
    await eligibility(db, live);
    if (!onboardingEmailEnabled()) throw new AppError(409, "onboarding_email_disabled", "Service email dispatch is disabled.");
    if (live.attempts >= 3) throw new AppError(409, "onboarding_email_attempts_exhausted", "The email attempt limit was reached.");
    let current: FrozenOnboardingEmailConfiguration;
    try { current = onboardingEmailConfiguration(); } catch { throw new AppError(503, "onboarding_email_provider_unavailable", "The frozen email provider is unavailable."); }
    if (JSON.stringify(current) !== decryptSensitive(live.provider_config_cipher!, scope(live))) throw new AppError(409, "onboarding_email_provider_changed", "Review the changed email provider configuration.");
    const writeClock = nowIso();
    const updated = await db.execute("UPDATE mca_onboarding_service_emails SET attempts=attempts+1,updated_at=? WHERE id=? AND state='sending' AND claim_token=? AND lease_until>? AND lease_until::timestamptz>clock_timestamp() AND attempts<3", [writeClock, live.id, live.claim_token, writeClock]);
    if (!updated) throw new AppError(409, "onboarding_email_lease_lost", "The email dispatch lease is no longer live.");
  });
}

/** Only a current token with a live lease can record a dispatch result and its receipt. */
export async function recordOnboardingEmailDispatchOutcome(id: string, token: string, outcome: OnboardingEmailDispatchOutcome): Promise<boolean> {
  return withTransaction(async db => {
    const clock = nowIso(), row = await leasedRow(db, id, token, clock);
    if (!row) return false;
    // Parked invites sit above the current generation; only older generations are stale.
    const current = (await findEnrollment(row.enrollment_id, db))?.emailGeneration;
    if (outcome.state !== "suppressed" && (row.superseded_by_generation || current === undefined || current > row.generation)) return false;
    const state = outcome.state === "retry" && row.attempts >= 3 ? "failed" : outcome.state;
    const providerId = outcome.providerMessageId?.trim() || null;
    if (state === "accepted" && !providerId) throw new AppError(422, "onboarding_email_acceptance_invalid", "Acceptance requires a provider identifier.");
    const error = ["retry", "failed", "uncertain", "suppressed"].includes(state) ? safeCode(outcome.errorCode) : null;
    const writeClock = nowIso(), next = state === "retry" ? afterMinutes(writeClock, row.attempts === 1 ? 15 : 30) : writeClock;
    const updated = await db.execute("UPDATE mca_onboarding_service_emails SET state=?,provider_message_id=?,error_code=?,next_attempt_at=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='sending' AND claim_token=? AND lease_until>? AND lease_until::timestamptz>clock_timestamp() AND (? OR (superseded_by_generation IS NULL AND EXISTS(SELECT 1 FROM mca_enrollments e WHERE e.id=mca_onboarding_service_emails.enrollment_id AND e.email_generation<=mca_onboarding_service_emails.generation)))", [state, providerId, error, next, writeClock, id, token, writeClock, state === "suppressed"]);
    if (!updated) return false;
    if (outcome.evidence && row.provider && row.provider_account_id) await db.execute("INSERT INTO mca_onboarding_service_email_receipts(id,enrollment_id,email_id,provider,provider_account_id,event_key,state,provider_message_id,evidence_type,error_code,occurred_at,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,provider_account_id,event_key) DO NOTHING", [newId(), row.enrollment_id, id, row.provider, row.provider_account_id, `dispatch:${id}:${row.attempts}:${token}`, state, providerId, outcome.evidence, error, writeClock, writeClock]);
    return true;
  });
}

export async function runOnboardingEmails(options?: { limit?: number; deadlineMs?: number; clock?: string }): Promise<{ attempted: number; accepted: number; uncertain: number; suppressed: number }> {
  const result = { attempted: 0, accepted: 0, uncertain: 0, suppressed: 0 };
  if (!onboardingEmailEnabled()) return result;
  const clock = options?.clock ?? nowIso(), limit = options?.limit ?? 25;
  if (!Number.isFinite(Date.parse(clock)) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (options?.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs))) throw new AppError(422, "onboarding_email_options_invalid", "Use a valid clock, absolute deadline and a limit from 1 to 100.");
  const deadline = Math.min(options?.deadlineMs ?? Infinity, Date.now() + 230000);
  if (deadline - Date.now() < 20000) return result;
  result.uncertain += await expireClaims(nowIso());
  for (let index = 0; index < limit && deadline - Date.now() >= 20000; index++) {
    const claimed = await claim(clock);
    if (!claimed) break;
    let row: EmailRow | undefined;
    try { row = await freeze(claimed); }
    catch (error) {
      const code = error instanceof AppError ? safeCode(error.code) : "onboarding_email_preflight_failed";
      if (!claimed.frozen_at && ["onboarding_email_unconfigured", "onboarding_email_from_invalid", "onboarding_email_endpoint_invalid", "onboarding_email_origin_invalid", "system_email_reply_to_invalid"].includes(code)) { await deferUnconfigured(claimed, code); continue; }
      const state = ["onboarding_email_suppressed", "onboarding_email_superseded"].includes(code) ? "suppressed" : "failed";
      if (await recordOnboardingEmailDispatchOutcome(claimed.id, claimed.claim_token!, { state, errorCode: code }) && state === "suppressed") result.suppressed++;
      continue;
    }
    if (!row) continue;
    let content: ReturnType<typeof renderOnboardingEmail>, recipient: string, configuration: FrozenOnboardingEmailConfiguration;
    try {
      content = contentSchema.parse(JSON.parse(decryptSensitive(row.content_cipher!, scope(row))));
      recipient = z.email().max(320).parse(decryptSensitive(row.recipient_cipher!, scope(row)));
      configuration = configurationSchema.parse(JSON.parse(decryptSensitive(row.provider_config_cipher!, scope(row))));
      if (enrollmentEmailHash(recipient) !== row.recipient_hash || configuration.provider !== row.provider || onboardingEmailProviderIdentity(configuration) !== row.provider_account_id) throw new Error("Invalid frozen email snapshot.");
    } catch {
      // An unsupported restored snapshot is operator work, never a retry or fabricated receipt.
      await recordOnboardingEmailDispatchOutcome(row.id, row.claim_token!, { state: "failed", errorCode: "onboarding_email_snapshot_unreadable" });
      continue;
    }
    let attempted = false;
    let outcome = await dispatchOnboardingEmail({ content, recipient, purpose: row.purpose, deliveryKey: row.delivery_key, configuration, deadlineMs: deadline, beforeSend: async () => { await beforeSend(row!); attempted = true; } });
    if (attempted) result.attempted++;
    let recorded: boolean;
    try { recorded = await recordOnboardingEmailDispatchOutcome(row.id, row.claim_token!, outcome); }
    catch (error) {
      const conflict = error as { code?: string; constraint?: string };
      if (conflict.code !== "23505" || conflict.constraint !== "mca_onboarding_emails_provider_idx") throw error;
      outcome = { state: "uncertain", errorCode: "onboarding_email_provider_id_conflict", evidence: "provider_response" };
      recorded = await recordOnboardingEmailDispatchOutcome(row.id, row.claim_token!, outcome);
    }
    if (recorded) {
      if (outcome.state === "accepted") result.accepted++;
      else if (outcome.state === "uncertain") result.uncertain++;
      else if (outcome.state === "suppressed") result.suppressed++;
    } else result.uncertain += await expireClaims(nowIso());
  }
  return result;
}
