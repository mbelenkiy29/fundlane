import "server-only";
import { assertTransactionExecutor, newId, nowIso, type DbExecutor } from "../db";
import { encryptSensitive, hmacScopedToken } from "../crypto";
import { AppError } from "../errors";
import type { EnrollmentRecord, OnboardingEmailPayload, OnboardingEmailPurpose } from "./contracts";
import { enrollmentEmailHash, findEnrollment, readEnrollmentContact } from "./store";

export const onboardingEmailEncryptionScope = (id: string, generation: number): string => `onboarding:email:${id}:${generation}`;
export const ONBOARDING_EMAIL_PURPOSES: readonly OnboardingEmailPurpose[] = ["business_information_requested", "getting_started"];
/** getting_started v2 is the set-password invite; any older row fails closed at freeze. */
export const ONBOARDING_EMAIL_TEMPLATE_VERSIONS: Record<OnboardingEmailPurpose, number> = { business_information_requested: 1, getting_started: 2 };

async function insertIntent(db: DbExecutor, enrollment: EnrollmentRecord, purpose: OnboardingEmailPurpose, generation: number, email: string, recipientHash: string): Promise<void> {
  const id = enrollment.id, now = nowIso();
  const payload: OnboardingEmailPayload = { version: 1, enrollmentId: id, generation, purpose, email, trialEndsAt: enrollment.trialEndsAt! };
  await db.execute(`INSERT INTO mca_onboarding_service_emails
    (id,enrollment_id,activation_version,purpose,generation,delivery_key,workspace_id,payload_cipher,recipient_hash,payload_hash,template_version,next_attempt_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(enrollment_id,activation_version,purpose,generation) DO NOTHING`,
  [newId(), id, enrollment.activationVersion, purpose, generation, `onboarding:${id}:${enrollment.activationVersion}:${purpose}:${generation}`, enrollment.workspaceId,
    encryptSensitive(JSON.stringify(payload), onboardingEmailEncryptionScope(id, generation)), recipientHash, hmacScopedToken("onboarding-email-payload", id, JSON.stringify(payload)), ONBOARDING_EMAIL_TEMPLATE_VERSIONS[purpose], now, now, now]);
}

/** Must share the activation transaction; does no provider I/O and requires no tenant. */
export async function enqueueOnboardingEmailIntents(id: string, generation: number, db: DbExecutor): Promise<void> {
  assertTransactionExecutor(db);
  await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [id]);
  const enrollment = await findEnrollment(id, db);
  if (!enrollment?.activatedAt || !enrollment.trialEndsAt || !enrollment.emailHash || generation !== enrollment.emailGeneration) {
    throw new AppError(409, "enrollment_email_generation_conflict", "Email intents require the current verified activation generation.");
  }
  const contact = readEnrollmentContact(enrollment);
  for (const purpose of ONBOARDING_EMAIL_PURPOSES) await insertIntent(db, enrollment, purpose, generation, contact.email, enrollment.emailHash);
}

/** Parked invites occupy generations above the current one; every generation bump must skip past them. */
export async function nextEmailGeneration(id: string, current: number, db: DbExecutor): Promise<number> {
  const top = await db.queryOne<{ generation: number }>("SELECT COALESCE(MAX(generation),0)::int generation FROM mca_onboarding_service_emails WHERE enrollment_id=?", [id]);
  return Math.max(current, top?.generation ?? 0) + 1;
}

/** A getting_started invite parked above the current generation: a pending email change, or a fresh link to the current address. */
export async function enqueueParkedInvite(id: string, generation: number, email: string, db: DbExecutor): Promise<void> {
  assertTransactionExecutor(db);
  await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [id]);
  const enrollment = await findEnrollment(id, db);
  if (!enrollment?.activatedAt || !enrollment.trialEndsAt || generation <= enrollment.emailGeneration) {
    throw new AppError(409, "enrollment_email_generation_conflict", "A parked invite requires a generation above the current one.");
  }
  const normalized = email.trim().toLowerCase();
  await insertIntent(db, enrollment, "getting_started", generation, normalized, enrollmentEmailHash(normalized));
}
