import "server-only";

import QRCode from "qrcode";
import { AppError } from "./errors";
import { getDatabase, newId, nowIso, withImmediateTransaction, type DbExecutor } from "./db";
import { decryptUserSecret, encryptUserSecret, totpEncryptionAvailable } from "./crypto";
import type { SupabaseIdentity } from "./supabase-auth";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeTotpCode,
  RECOVERY_CODE_COUNT,
  totpUri,
  verifyTotpCode,
} from "./totp";

const ISSUER = "Fundlane";

export type TotpSessionMethod = "pending" | "totp" | "recovery" | "google" | "not_required";

export interface TotpAccessState {
  available: boolean;
  enrolled: boolean;
  pending: boolean;
  recoveryRemaining: number;
  enrollmentRequired: boolean;
  challengeRequired: boolean;
  sessionVerified: boolean;
}

interface FactorRow {
  user_id: string;
  status: "pending" | "enabled";
  secret_cipher: string;
  last_used_counter: string | number | null;
  confirmed_at: string | null;
}

function assertTotpAvailable(): void {
  if (!totpEncryptionAvailable()) {
    throw new AppError(503, "totp_unavailable", "Two-factor authentication is not configured on this deployment.");
  }
}

export async function resolveAppUserId(supabaseUserId: string): Promise<string | null> {
  const row = await getDatabase().prepare<{ id: string }>("SELECT id FROM users WHERE supabase_user_id = ?").get(supabaseUserId);
  return row?.id ?? null;
}

export function isGoogleOauthCallback(input: {
  hasCode: boolean;
  hasTokenHash: boolean;
  type: string | null;
  provider?: string | null;
  next?: string | null;
}): boolean {
  if (!input.hasCode || input.hasTokenHash || input.provider !== "google") return false;
  if (input.type === "email" || input.type === "signup" || input.type === "recovery") return false;
  return !input.next?.startsWith("/reset-password");
}

export async function getTotpAccessState(input: {
  userId: string | null;
  sessionId: string | null;
  workspaceId?: string | null;
}): Promise<TotpAccessState> {
  const available = totpEncryptionAvailable();
  if (!input.userId) {
    return {
      available,
      enrolled: false,
      pending: false,
      recoveryRemaining: 0,
      enrollmentRequired: false,
      challengeRequired: false,
      sessionVerified: false,
    };
  }
  const factor = await getDatabase().prepare<FactorRow>("SELECT user_id, status, secret_cipher, last_used_counter, confirmed_at FROM user_totp_factors WHERE user_id = ?").get(input.userId);
  const remaining = await getDatabase().prepare<{ count: number }>("SELECT count(*)::int count FROM user_totp_recovery_codes WHERE user_id = ? AND used_at IS NULL").get(input.userId);
  const session = input.sessionId
    ? await getDatabase().prepare<{ method: TotpSessionMethod; verified_at: string | null }>("SELECT method, verified_at FROM auth_session_totp WHERE session_id = ? AND user_id = ?").get(input.sessionId, input.userId)
    : undefined;
  let require2fa = false;
  if (input.workspaceId) {
    const workspace = await getDatabase().prepare<{ require_2fa: boolean | null }>("SELECT require_2fa FROM workspaces WHERE id = ?").get(input.workspaceId);
    require2fa = workspace?.require_2fa === true;
  } else {
    const required = await getDatabase().prepare<{ require_2fa: boolean | null }>(`SELECT w.require_2fa FROM workspaces w
      JOIN memberships m ON m.workspace_id = w.id AND m.status = 'active'
      WHERE m.user_id = ? AND w.require_2fa IS TRUE LIMIT 1`).get(input.userId);
    require2fa = required?.require_2fa === true;
  }
  const enrolled = factor?.status === "enabled";
  const sessionVerified = Boolean(session?.verified_at) && session?.method !== "pending";
  return {
    available,
    enrolled,
    pending: factor?.status === "pending",
    recoveryRemaining: remaining?.count ?? 0,
    enrollmentRequired: require2fa && !enrolled,
    challengeRequired: enrolled && !sessionVerified,
    sessionVerified,
  };
}

export async function assertSessionTotpAccess(input: {
  userId: string;
  sessionId: string;
  workspaceId: string;
}): Promise<void> {
  const state = await getTotpAccessState(input);
  if (state.enrollmentRequired) throw new AppError(403, "totp_enrollment_required", "Your company requires two-factor authentication. Enroll an authenticator to continue.");
  if (state.challengeRequired) throw new AppError(403, "totp_required", "Enter an authenticator or recovery code to finish signing in.");
}

export async function startPasswordTotpChallenge(identity: SupabaseIdentity): Promise<{ mfaRequired: boolean }> {
  const userId = await resolveAppUserId(identity.user.id);
  if (!userId) return { mfaRequired: false };
  const factor = await getDatabase().prepare<FactorRow>("SELECT user_id, status, secret_cipher, last_used_counter, confirmed_at FROM user_totp_factors WHERE user_id = ? AND status = 'enabled'").get(userId);
  const now = nowIso();
  await upsertSessionTotp(identity.sessionId, userId, factor ? "pending" : "not_required", factor ? null : now);
  return { mfaRequired: Boolean(factor) };
}

export async function markGoogleTotpSession(identity: SupabaseIdentity): Promise<void> {
  const userId = await resolveAppUserId(identity.user.id);
  if (!userId) return;
  await upsertSessionTotp(identity.sessionId, userId, "google", nowIso());
}

export async function beginTotpEnrollment(userId: string, account: string): Promise<{ secret: string; qrCode: string; otpauthUrl: string }> {
  assertTotpAvailable();
  const existing = await getDatabase().prepare<FactorRow>("SELECT user_id, status, secret_cipher, last_used_counter, confirmed_at FROM user_totp_factors WHERE user_id = ?").get(userId);
  if (existing?.status === "enabled") throw new AppError(409, "totp_already_enabled", "Two-factor authentication is already enabled. Disable it before enrolling a new authenticator.");
  const secret = generateTotpSecret();
  const otpauthUrl = totpUri({ issuer: ISSUER, account, secret });
  const qrCode = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 1, width: 200 });
  const now = nowIso();
  await getDatabase().prepare(`INSERT INTO user_totp_factors (user_id, status, secret_cipher, last_used_counter, confirmed_at, created_at, updated_at)
    VALUES (?, 'pending', ?, NULL, NULL, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET status = 'pending', secret_cipher = EXCLUDED.secret_cipher, last_used_counter = NULL, confirmed_at = NULL, updated_at = EXCLUDED.updated_at`)
    .run(userId, encryptUserSecret(secret, userId), now, now);
  return { secret, qrCode, otpauthUrl };
}

export async function confirmTotpEnrollment(userId: string, code: string, sessionId?: string | null): Promise<{ recoveryCodes: string[] }> {
  assertTotpAvailable();
  return withImmediateTransaction(async (database) => {
    const factor = await database.prepare<FactorRow>("SELECT user_id, status, secret_cipher, last_used_counter, confirmed_at FROM user_totp_factors WHERE user_id = ? FOR UPDATE").get(userId);
    if (!factor || factor.status !== "pending") throw new AppError(400, "totp_enrollment_required", "Start authenticator enrollment before confirming a code.");
    const secret = decryptUserSecret(factor.secret_cipher, userId);
    const verified = verifyTotpCode(secret, code);
    if (!verified.valid || verified.counter == null) throw new AppError(400, "totp_verification_failed", "That code is invalid or expired. Enter a new authenticator code.");
    const now = nowIso();
    const recoveryCodes = generateRecoveryCodes();
    await database.prepare("DELETE FROM user_totp_recovery_codes WHERE user_id = ?").run(userId);
    for (const recovery of recoveryCodes) {
      const hash = hashRecoveryCode(recovery);
      if (!hash) throw new Error("Failed to hash a recovery code.");
      await database.prepare("INSERT INTO user_totp_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)").run(newId(), userId, hash, now);
    }
    await database.prepare("UPDATE user_totp_factors SET status = 'enabled', last_used_counter = ?, confirmed_at = ?, updated_at = ? WHERE user_id = ?")
      .run(verified.counter, now, now, userId);
    if (sessionId) await upsertSessionTotp(sessionId, userId, "totp", now, database);
    return { recoveryCodes };
  });
}

export async function challengeTotp(userId: string, sessionId: string, code: string): Promise<{ method: "totp" | "recovery" }> {
  assertTotpAvailable();
  return withImmediateTransaction(async (database) => {
    const method = await consumeTotpOrRecovery(database, userId, code);
    await upsertSessionTotp(sessionId, userId, method, nowIso(), database);
    return { method };
  });
}

export async function disableTotp(userId: string, code: string): Promise<void> {
  assertTotpAvailable();
  await withImmediateTransaction(async (database) => {
    await consumeTotpOrRecovery(database, userId, code);
    await database.prepare("DELETE FROM user_totp_recovery_codes WHERE user_id = ?").run(userId);
    await database.prepare("DELETE FROM user_totp_factors WHERE user_id = ?").run(userId);
    await database.prepare("DELETE FROM auth_session_totp WHERE user_id = ?").run(userId);
  });
}

export async function regenerateRecoveryCodes(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  assertTotpAvailable();
  return withImmediateTransaction(async (database) => {
    await consumeTotpOrRecovery(database, userId, code, { allowPending: false });
    const now = nowIso();
    const recoveryCodes = generateRecoveryCodes();
    await database.prepare("DELETE FROM user_totp_recovery_codes WHERE user_id = ?").run(userId);
    for (const recovery of recoveryCodes) {
      const hash = hashRecoveryCode(recovery);
      if (!hash) throw new Error("Failed to hash a recovery code.");
      await database.prepare("INSERT INTO user_totp_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)").run(newId(), userId, hash, now);
    }
    return { recoveryCodes };
  });
}

async function consumeTotpOrRecovery(
  database: DbExecutor,
  userId: string,
  code: string,
  options: { allowPending?: boolean } = {},
): Promise<"totp" | "recovery"> {
  const factor = await database.prepare<FactorRow>("SELECT user_id, status, secret_cipher, last_used_counter, confirmed_at FROM user_totp_factors WHERE user_id = ? FOR UPDATE").get(userId);
  if (!factor || (factor.status !== "enabled" && !options.allowPending)) {
    throw new AppError(400, "totp_not_enabled", "Two-factor authentication is not enabled for this account.");
  }
  if (normalizeTotpCode(code)) {
    const secret = decryptUserSecret(factor.secret_cipher, userId);
    const verified = verifyTotpCode(secret, code);
    const last = factor.last_used_counter == null ? null : Number(factor.last_used_counter);
    if (!verified.valid || verified.counter == null || (last != null && verified.counter <= last)) {
      throw new AppError(400, "totp_verification_failed", "That code is invalid or expired. Enter a new authenticator or recovery code.");
    }
    await database.prepare("UPDATE user_totp_factors SET last_used_counter = ?, updated_at = ? WHERE user_id = ?").run(verified.counter, nowIso(), userId);
    return "totp";
  }
  const hash = hashRecoveryCode(code);
  if (!hash) throw new AppError(400, "totp_verification_failed", "That code is invalid or expired. Enter a new authenticator or recovery code.");
  const unused = await database.prepare<{ id: string }>("SELECT id FROM user_totp_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL FOR UPDATE").get(userId, hash);
  if (!unused) throw new AppError(400, "totp_verification_failed", "That code is invalid or expired. Enter a new authenticator or recovery code.");
  await database.prepare("UPDATE user_totp_recovery_codes SET used_at = ? WHERE id = ? AND user_id = ?").run(nowIso(), unused.id, userId);
  return "recovery";
}

async function upsertSessionTotp(
  sessionId: string,
  userId: string,
  method: TotpSessionMethod,
  verifiedAt: string | null,
  executor: DbExecutor = getDatabase(),
): Promise<void> {
  await executor.prepare(`INSERT INTO auth_session_totp (session_id, user_id, method, verified_at, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id, method = EXCLUDED.method, verified_at = EXCLUDED.verified_at`)
    .run(sessionId, userId, method, verifiedAt, nowIso());
}

export async function sessionHasAppTotp(sessionId: string, userId: string): Promise<boolean> {
  const row = await getDatabase().prepare<{ method: TotpSessionMethod; verified_at: string | null }>("SELECT method, verified_at FROM auth_session_totp WHERE session_id = ? AND user_id = ?")
    .get(sessionId, userId);
  return Boolean(row?.verified_at) && (row?.method === "totp" || row?.method === "recovery");
}

export { RECOVERY_CODE_COUNT };
