import "server-only";

import { createOpaqueToken, hashOpaqueToken, verifyPassword, hashPassword } from "./crypto";
import { AppError } from "./errors";
import { getDatabase, newId, nowIso, withImmediateTransaction } from "./db";
import { effectiveActionVisibility, effectivePageVisibility, canManageApiKeys, canManageUsers, canManageWorkspace, canViewCompanyFinancials } from "./policy";
import { getWorkspaceSettings, ensureBootstrapFromEnvironment } from "./workspaces";
import type { MembershipContext, Role, SessionResponse } from "./types";

const SESSION_DURATION_MS = 12 * 60 * 60 * 1_000;

interface ActiveMembershipRow {
  membership_id: string;
  workspace_id: string;
  workspace_name: string;
  role: Role;
  manager_membership_id: string | null;
  user_id: string;
  email: string;
  password_hash: string | null;
  name: string;
  phone: string | null;
  application_identifier: string;
}

async function responseForRow(row: ActiveMembershipRow): Promise<SessionResponse> {
  const settings = await getWorkspaceSettings(row.workspace_id);
  const pages = effectivePageVisibility(row.role, settings.pageVisibility, settings.featureFlags);
  const actions = effectiveActionVisibility(row.role, settings.actionVisibility);
  return {
    authenticated: true,
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      applicationIdentifier: row.application_identifier,
    },
    membership: {
      id: row.membership_id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      role: row.role,
      managerMembershipId: row.manager_membership_id,
    },
    permissions: {
      pages,
      actions,
      canManageUsers: canManageUsers(row.role),
      canManageWorkspace: canManageWorkspace(row.role),
      canManageApiKeys: canManageApiKeys(row.role),
      canViewCompanyFinancials: canViewCompanyFinancials(row.role) && actions.viewCompanyFinancials,
      canAccessPayments: pages.payments && actions.viewPaymentTable,
    },
  };
}

export async function createSession(userId: string, membershipId: string): Promise<{ token: string; expiresAt: string }> {
  const token = createOpaqueToken();
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await getDatabase().prepare(`INSERT INTO sessions
    (id, user_id, membership_id, token_hash, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(newId(), userId, membershipId, hashOpaqueToken(token), expiresAt, timestamp, timestamp);
  return { token, expiresAt };
}

export async function signIn(input: { email: string; password: string; workspaceId?: string }): Promise<{
  token: string;
  expiresAt: string;
  session: SessionResponse;
}> {
  await ensureBootstrapFromEnvironment();
  const row = await getDatabase().prepare<ActiveMembershipRow>(`SELECT
      m.id membership_id, m.workspace_id, w.name workspace_name, m.role, m.manager_membership_id,
      u.id user_id, u.email, u.password_hash, u.name, u.phone, u.application_identifier
    FROM users u
    JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE lower(u.email) = lower(?) AND (?::text IS NULL OR m.workspace_id = ?)
    ORDER BY m.created_at ASC LIMIT 1`).get(input.email.trim(), input.workspaceId ?? null, input.workspaceId ?? null);
  // Perform a comparable scrypt operation even when no account exists.
  const valid = row ? verifyPassword(input.password, row.password_hash) : verifyPassword(input.password, hashPassword("invalid-password-placeholder"));
  if (!row || !valid) throw new AppError(401, "invalid_credentials", "Email or password is incorrect.");
  const session = await createSession(row.user_id, row.membership_id);
  return { ...session, session: await responseForRow(row) };
}

export async function getSessionResponse(context: MembershipContext): Promise<SessionResponse> {
  const row = await getDatabase().prepare<ActiveMembershipRow>(`SELECT
      m.id membership_id, m.workspace_id, w.name workspace_name, m.role, m.manager_membership_id,
      u.id user_id, u.email, u.password_hash, u.name, u.phone, u.application_identifier
    FROM memberships m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.id = ? AND m.workspace_id = ? AND m.status = 'active'`).get(context.membershipId, context.workspaceId);
  if (!row) throw new AppError(401, "session_invalid", "Your session is no longer valid.");
  return responseForRow(row);
}

export async function signOut(sessionId: string): Promise<void> {
  await getDatabase().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export async function consumeRecoveryToken(token: string, password: string): Promise<void> {
  const passwordHash = hashPassword(password);
  await withImmediateTransaction(async (database) => {
    const now = nowIso();
    const row = await database.prepare<{ id: string; user_id: string }>(`UPDATE recovery_tokens SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      RETURNING id, user_id`).get(now, hashOpaqueToken(token), now);
    if (!row) throw new AppError(400, "recovery_token_invalid", "This recovery link is invalid or expired.");
    await database.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(passwordHash, now, row.user_id);
    await database.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
  });
}
