import "server-only";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BILLING_CATALOG } from "../billing-catalog";
import { assertTransactionExecutor, getDatabase, newId, nowIso, type DbExecutor } from "../db";
import { decryptSensitive, encryptSensitive, hashOpaqueToken, hmacScopedToken } from "../crypto";
import { AppError } from "../errors";
import type { EnrollmentActivation, EnrollmentContact, EnrollmentOffer, EnrollmentRecord } from "./contracts";
import type { EnrollmentDatabaseRow as EnrollmentRow } from "../db/onboarding";
import { enqueueOnboardingEmailIntents } from "./email-intents";

const offerSchema = z.object({
  version: z.literal(1), accountId: z.string().regex(/^acct_[A-Za-z0-9]+$/),
  basePriceId: z.string().regex(/^price_[A-Za-z0-9]+$/), seatPriceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
  currency: z.literal("usd"), baseAmount: z.literal(BILLING_CATALOG.base.unitAmountCents), quantity: z.literal(1), trialDays: z.literal(14),
  livemode: z.boolean(), promotionCodes: z.boolean(), automaticTax: z.boolean(),
}).strict().refine(value => value.basePriceId !== value.seatPriceId);
const activationSchema = z.object({
  sessionId: z.string().min(1).max(255), customerId: z.string().min(1).max(255), subscriptionId: z.string().min(1).max(255),
  email: z.email().max(320), businessName: z.string().trim().min(1).max(255),
  trialStartedAt: z.iso.datetime(), trialEndsAt: z.iso.datetime(), verifiedAt: z.iso.datetime(),
  billingStatus: z.enum(["trialing", "active", "paused", "incomplete", "incomplete_expired", "past_due", "unpaid", "canceled"]), livemode: z.boolean(),
}).strict();

export function enrollmentEmailHash(email: string): string {
  return hmacScopedToken("onboarding-email", "platform", email.trim().toLowerCase());
}
export function enrollmentEmailDomainHash(email: string): string {
  const normalized = email.trim().toLowerCase();
  return hmacScopedToken("onboarding-email-domain", "platform", normalized.slice(normalized.lastIndexOf("@") + 1));
}
export const enrollmentEncryptionScope = (id: string): string => `onboarding:enrollment:${id}`;
export const enrollmentChallengeScope = (id: string): string => `onboarding:challenge:${id}`;
/** Only an unclaimed enrollment with no prior account may receive or use a set-password invite. */
export const newOwnerEnrollment = (row: EnrollmentRecord): boolean =>
  !row.workspaceId && !row.claimedProviderUserId && !row.initiatingProviderUserId && row.claimState === "unclaimed";

function mapEnrollment(row: EnrollmentRow): EnrollmentRecord {
  return {
    id: row.id, resumeSecretHash: row.resume_secret_hash, offer: offerSchema.parse(JSON.parse(row.offer_json)), providerAccountId: row.provider_account_id,
    initiatingProviderUserId: row.initiating_provider_user_id, claimedProviderUserId: row.claimed_provider_user_id, userId: row.user_id, workspaceId: row.workspace_id,
    checkoutState: row.checkout_state, billingState: row.billing_state, claimState: row.claim_state, finalizationState: row.finalization_state, recoveryState: row.recovery_state,
    checkoutSessionId: row.checkout_session_id, customerId: row.customer_id, subscriptionId: row.subscription_id,
    contactCipher: row.contact_cipher, providerSnapshotCipher: row.provider_snapshot_cipher, emailHash: row.email_hash, emailDomainHash: row.email_domain_hash,
    activationEmailHash: row.activation_email_hash, activationEmailDomainHash: row.activation_email_domain_hash,
    trialStartedAt: row.trial_started_at, trialEndsAt: row.trial_ends_at, activatedAt: row.activated_at, verifiedAt: row.verified_at,
    revision: row.revision, activationVersion: row.activation_version, checkoutGeneration: row.checkout_generation, resumeGeneration: row.resume_generation, emailGeneration: row.email_generation,
    checkoutRequestKey: row.checkout_request_key, checkoutRequestedAt: row.checkout_requested_at, checkoutExpiresAt: row.checkout_expires_at,
    claimToken: row.claim_token, leaseUntil: row.lease_until, nextReconcileAt: row.next_reconcile_at, errorCode: row.error_code,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function createEnrollment(input: { resumeSecret: string; offer: EnrollmentOffer; initiatingProviderUserId?: string }, db: DbExecutor = getDatabase()): Promise<EnrollmentRecord> {
  if (input.resumeSecret.length < 32 || input.resumeSecret.length > 512) throw new AppError(400, "enrollment_resume_invalid", "A high-entropy browser binding is required.");
  const validated = offerSchema.safeParse(input.offer);
  if (!validated.success) throw new AppError(503, "enrollment_offer_invalid", "The trial offer is invalid.");
  const id = newId(), now = nowIso(), resumeHash = hashOpaqueToken(input.resumeSecret);
  const row = await db.queryOne<EnrollmentRow>(`INSERT INTO mca_enrollments(id,resume_secret_hash,offer_json,provider_account_id,initiating_provider_user_id,checkout_request_key,next_reconcile_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(resume_secret_hash) DO NOTHING RETURNING *`,
  [id, resumeHash, JSON.stringify(validated.data), validated.data.accountId, input.initiatingProviderUserId ?? null, `enrollment:${id}:checkout:1`, now, now, now]);
  const result = row ?? await db.queryOne<EnrollmentRow>("SELECT * FROM mca_enrollments WHERE resume_secret_hash=?", [resumeHash]);
  if (!result) throw new AppError(409, "enrollment_conflict", "Enrollment creation conflict; retry the request.");
  const record = mapEnrollment(result);
  if (JSON.stringify(record.offer) !== JSON.stringify(validated.data) || record.initiatingProviderUserId !== (input.initiatingProviderUserId ?? null)) {
    throw new AppError(409, "enrollment_conflict", "The existing enrollment has a different offer or identity binding.");
  }
  return record;
}

export async function findEnrollment(id: string, db: DbExecutor = getDatabase()): Promise<EnrollmentRecord | undefined> {
  const row = await db.queryOne<EnrollmentRow>("SELECT * FROM mca_enrollments WHERE id=?", [id]);
  return row ? mapEnrollment(row) : undefined;
}

export function verifyEnrollmentResume(row: EnrollmentRecord, secret: string): boolean {
  if (!secret || secret.length > 512 || !/^[0-9a-f]{64}$/.test(row.resumeSecretHash)) return false;
  const actual = Buffer.from(hashOpaqueToken(secret), "hex"), expected = Buffer.from(row.resumeSecretHash, "hex");
  return timingSafeEqual(actual, expected);
}

export function readEnrollmentContact(row: EnrollmentRecord): EnrollmentContact {
  if (!row.contactCipher) throw new AppError(409, "enrollment_contact_missing", "Enrollment contact is not yet verified.");
  return z.object({ email: z.email().max(320), businessName: z.string().min(1).max(255) }).strict().parse(JSON.parse(decryptSensitive(row.contactCipher, enrollmentEncryptionScope(row.id))));
}

export async function recordEnrollmentActivation(id: string, activation: EnrollmentActivation, db: DbExecutor): Promise<void> {
  assertTransactionExecutor(db);
  const parsed = activationSchema.safeParse(activation);
  if (!parsed.success) throw new AppError(409, "enrollment_activation_invalid", "The verified trial activation is incomplete.");
  const value = parsed.data;
  const locked = await db.queryOne<EnrollmentRow>("SELECT * FROM mca_enrollments WHERE id=? FOR UPDATE", [id]);
  if (!locked) throw new AppError(404, "enrollment_not_found", "Enrollment not found.");
  const row = mapEnrollment(locked);
  if (row.offer.livemode !== value.livemode || Date.parse(value.trialEndsAt) - Date.parse(value.trialStartedAt) !== 14 * 86400 * 1000) {
    throw new AppError(409, "enrollment_activation_conflict", "Trial activation conflicts with the enrollment offer.");
  }
  const startedAt = new Date(value.trialStartedAt).toISOString(), endsAt = new Date(value.trialEndsAt).toISOString();
  if ((row.checkoutSessionId && row.checkoutSessionId !== value.sessionId) || (row.customerId && row.customerId !== value.customerId) || (row.subscriptionId && row.subscriptionId !== value.subscriptionId)
    || (row.trialStartedAt && row.trialStartedAt !== startedAt) || (row.trialEndsAt && row.trialEndsAt !== endsAt)) {
    throw new AppError(409, "enrollment_activation_conflict", "Trial activation conflicts with the existing provider association.");
  }
  if (!row.activatedAt) {
    const emailHash = enrollmentEmailHash(value.email), domainHash = enrollmentEmailDomainHash(value.email), scope = enrollmentEncryptionScope(id);
    const changes = await db.execute(`UPDATE mca_enrollments SET checkout_state='complete',billing_state=?,checkout_session_id=?,customer_id=?,subscription_id=?,
      contact_cipher=?,provider_snapshot_cipher=?,email_hash=?,email_domain_hash=?,activation_email_hash=?,activation_email_domain_hash=?,
      trial_started_at=?,trial_ends_at=?,activated_at=?,verified_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`,
    [value.billingStatus, value.sessionId, value.customerId, value.subscriptionId,
      encryptSensitive(JSON.stringify({ email: value.email.trim().toLowerCase(), businessName: value.businessName }), scope), encryptSensitive(JSON.stringify({ ...value, accountId: row.providerAccountId }), scope),
      emailHash, domainHash, emailHash, domainHash, startedAt, endsAt, new Date(value.verifiedAt).toISOString(), new Date(value.verifiedAt).toISOString(), nowIso(), id, row.revision]);
    if (changes !== 1) throw new AppError(409, "enrollment_revision_conflict", "Enrollment revision conflict.");
  }
  await enqueueOnboardingEmailIntents(id, row.emailGeneration, db);
}
