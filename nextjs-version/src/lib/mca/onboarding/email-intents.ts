import "server-only";
import { assertTransactionExecutor, newId, nowIso, type DbExecutor } from "../db";
import { encryptSensitive, hmacScopedToken } from "../crypto";
import { AppError } from "../errors";
import type { OnboardingEmailPayload, OnboardingEmailPurpose } from "./contracts";
import { findEnrollment, readEnrollmentContact } from "./store";

export const onboardingEmailEncryptionScope = (id: string, generation: number): string => `onboarding:email:${id}:${generation}`;
export const ONBOARDING_EMAIL_PURPOSES: readonly OnboardingEmailPurpose[] = ["business_information_requested", "getting_started"];

/** Must share the activation transaction; does no provider I/O and requires no tenant. */
export async function enqueueOnboardingEmailIntents(id: string, generation: number, db: DbExecutor): Promise<void> {
  assertTransactionExecutor(db);
  await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [id]);
  const enrollment = await findEnrollment(id, db);
  if (!enrollment?.activatedAt || !enrollment.trialEndsAt || !enrollment.emailHash || generation !== enrollment.emailGeneration) {
    throw new AppError(409, "enrollment_email_generation_conflict", "Email intents require the current verified activation generation.");
  }
  const contact = readEnrollmentContact(enrollment), now = nowIso();
  for (const purpose of ONBOARDING_EMAIL_PURPOSES) {
    const payload: OnboardingEmailPayload = { version: 1, enrollmentId: id, generation, purpose, email: contact.email, trialEndsAt: enrollment.trialEndsAt };
    await db.execute(`INSERT INTO mca_onboarding_service_emails
      (id,enrollment_id,activation_version,purpose,generation,delivery_key,workspace_id,payload_cipher,recipient_hash,payload_hash,template_version,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(enrollment_id,activation_version,purpose,generation) DO NOTHING`,
    [newId(), id, enrollment.activationVersion, purpose, generation, `onboarding:${id}:${enrollment.activationVersion}:${purpose}:${generation}`, enrollment.workspaceId,
      encryptSensitive(JSON.stringify(payload), onboardingEmailEncryptionScope(id, generation)), enrollment.emailHash, hmacScopedToken("onboarding-email-payload", id, JSON.stringify(payload)), 1, now, now, now]);
  }
}
