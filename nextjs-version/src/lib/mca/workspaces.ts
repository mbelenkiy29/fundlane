import "server-only";

import { AppError } from "./errors";
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "./db";
import { hashPassword, totpEncryptionAvailable } from "./crypto";
import { billingEnabled } from "./billing";
import type { ActionVisibility, AuthContext, FeatureFlags, PageVisibility, Role, WorkspaceSettings } from "./types";

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  reports: true,
  payments: false,
  integrations: true,
  dealAgent: false,
};

export const DEFAULT_PAGE_VISIBILITY: PageVisibility = {
  dashboard: true,
  deals: true,
  users: true,
  reports: true,
  payments: true,
  workspace: true,
  integrations: true,
};

export const DEFAULT_ACTION_VISIBILITY: ActionVisibility = {
  createDeal: true,
  exportDeals: true,
  inviteUsers: true,
  manageApiKeys: true,
  viewPaymentTable: true,
  viewCompanyFinancials: true,
};

interface WorkspaceRow {
  id: string;
  name: string;
  logo_url: string | null;
  timezone: string;
  seat_limit: number;
  feature_flags: string;
  page_visibility: string;
  action_visibility: string;
  require_2fa: boolean | null;
  updated_at: string;
  clerk_organization_id: string | null;
}

function mapWorkspace(row: WorkspaceRow): WorkspaceSettings {
  const featureFlags = parseJson(row.feature_flags, DEFAULT_FEATURE_FLAGS);
  return {
    workspaceId: row.id,
    brokerageName: row.name,
    logoUrl: row.logo_url,
    timezone: row.timezone,
    seatLimit: row.seat_limit,
    seatLimitManaged: billingEnabled(),
    featureFlags: { ...featureFlags, dealAgent: featureFlags.dealAgent === true },
    featureAvailability: { dealAgent: { available: process.env.MCA_DEAL_AGENT_ENABLED === "true" } },
    pageVisibility: parseJson(row.page_visibility, DEFAULT_PAGE_VISIBILITY),
    actionVisibility: parseJson(row.action_visibility, DEFAULT_ACTION_VISIBILITY),
    require2fa: row.require_2fa === true,
    updatedAt: row.updated_at,
  };
}

export async function getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings> {
  const row = await getDatabase().prepare<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?").get(workspaceId);
  if (!row) throw new AppError(404, "workspace_not_found", "Workspace not found.");
  return mapWorkspace(row);
}

export type WorkspaceSettingsPatch = Partial<Omit<WorkspaceSettings, "workspaceId" | "updatedAt" | "featureFlags" | "featureAvailability" | "pageVisibility" | "actionVisibility">> & {
  featureFlags?: Partial<FeatureFlags>;
  pageVisibility?: Partial<PageVisibility>;
  actionVisibility?: Partial<ActionVisibility>;
};

export async function updateWorkspaceSettings(
  context: AuthContext,
  patch: WorkspaceSettingsPatch,
): Promise<WorkspaceSettings> {
  const updated = await withImmediateTransaction(async (database) => {
    await database.prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE").get(context.workspaceId);
    const current = await getWorkspaceSettings(context.workspaceId);
    if (current.seatLimitManaged && patch.seatLimit !== undefined && patch.seatLimit !== current.seatLimit) throw new AppError(409, "billing_managed_seats", "Change company seats from Plans & Billing.");
    if (patch.require2fa === true && !totpEncryptionAvailable()) {
      throw new AppError(503, "totp_unavailable", "Two-factor authentication is not configured on this deployment.");
    }
    const next: WorkspaceSettings = {
      ...current,
      ...patch,
      featureFlags: { ...current.featureFlags, ...(patch.featureFlags ?? {}) },
      pageVisibility: { ...current.pageVisibility, ...(patch.pageVisibility ?? {}) },
      actionVisibility: { ...current.actionVisibility, ...(patch.actionVisibility ?? {}) },
      workspaceId: current.workspaceId,
      updatedAt: nowIso(),
    };
    const activeSeats = await database.prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id = ? AND status IN ('pending','active')")
      .get(context.workspaceId);
    if (!activeSeats) throw new Error("Seat count query did not return a row.");
    if (!current.seatLimitManaged && next.seatLimit < activeSeats.count) {
      throw new AppError(409, "seat_limit_below_usage", `Seat limit cannot be lower than the ${activeSeats.count} reserved seats.`);
    }
    await database.prepare(`UPDATE workspaces SET name = ?, logo_url = ?, timezone = ?, seat_limit = ?,
      feature_flags = ?, page_visibility = ?, action_visibility = ?, require_2fa = ?, updated_at = ? WHERE id = ?`).run(
        next.brokerageName,
        next.logoUrl,
        next.timezone,
        next.seatLimit,
        JSON.stringify(next.featureFlags),
        JSON.stringify(next.pageVisibility),
        JSON.stringify(next.actionVisibility),
        next.require2fa,
        next.updatedAt,
        context.workspaceId,
      );
    await recordAuditEvent({ context, action: "workspace.settings.updated", resourceType: "workspace", resourceId: context.workspaceId, executor: database });
    return next;
  });
  return updated;
}

/** Internal/bootstrap fixture path. Customer sign-up uses Supabase onboarding and its trial flow. */
export async function createWorkspaceWithAdmin(input: {
  workspaceName: string;
  adminName: string;
  adminEmail: string;
  password: string;
  timezone?: string;
  seatLimit?: number;
  role?: Extract<Role, "admin" | "super_admin">;
}): Promise<{ workspaceId: string; userId: string; membershipId: string }> {
  const passwordHash = hashPassword(input.password);
  return withImmediateTransaction(async (database) => {
    const timestamp = nowIso();
    const workspaceId = newId();
    const userId = newId();
    const membershipId = newId();
    const email = input.adminEmail.trim().toLowerCase();
    await database.prepare(`INSERT INTO workspaces
      (id, name, logo_url, timezone, seat_limit, feature_flags, page_visibility, action_visibility, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
        workspaceId,
        input.workspaceName,
        input.timezone ?? "America/New_York",
        input.seatLimit ?? 5,
        JSON.stringify(DEFAULT_FEATURE_FLAGS),
        JSON.stringify(DEFAULT_PAGE_VISIBILITY),
        JSON.stringify(DEFAULT_ACTION_VISIBILITY),
        timestamp,
        timestamp,
      );
    await database.prepare(`INSERT INTO company_subscription_state (workspace_id,legacy_exempt,state_kind,selected_seats,updated_at)
      VALUES (?,1,'internal_demo',?,?)`).run(workspaceId,Math.max(1,input.seatLimit ?? 5),timestamp);
    const inserted = await database.prepare<{ id: string }>(`INSERT INTO users
      (id, email, password_hash, name, phone, application_identifier, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT (lower(email)) DO NOTHING RETURNING id`).get(
        userId,
        email,
        passwordHash,
        input.adminName,
        `MCA-${userId.slice(0, 8).toUpperCase()}`,
        timestamp,
        timestamp,
      );
    const resolvedUserId = inserted?.id
      ?? (await database.prepare<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower(?)").get(email))?.id;
    if (!resolvedUserId) throw new Error("Unable to resolve workspace administrator account.");
    await database.prepare(`INSERT INTO memberships
      (id, workspace_id, user_id, role, manager_membership_id, status, sender_association, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(
        membershipId,
        workspaceId,
        resolvedUserId,
        input.role ?? "super_admin",
        timestamp,
        timestamp,
      );
    return { workspaceId, userId: resolvedUserId, membershipId };
  });
}

let bootstrapChecked = false;
let bootstrapPromise: Promise<void> | undefined;
export async function ensureBootstrapFromEnvironment(): Promise<void> {
  if (bootstrapChecked) return;
  if (bootstrapPromise) return bootstrapPromise;
  const email = process.env.MCA_BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.MCA_BOOTSTRAP_ADMIN_PASSWORD;
  const workspaceName = process.env.MCA_BOOTSTRAP_WORKSPACE_NAME;
  if (!email && !password && !workspaceName) return;
  if (!email || !password || !workspaceName) {
    throw new Error("MCA bootstrap requires MCA_BOOTSTRAP_ADMIN_EMAIL, MCA_BOOTSTRAP_ADMIN_PASSWORD and MCA_BOOTSTRAP_WORKSPACE_NAME together.");
  }
  bootstrapPromise = withImmediateTransaction(async (database) => {
    await database.execute("SELECT pg_advisory_xact_lock(hashtext('fundlane-bootstrap'))");
    const existing = await database.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email.trim());
    if (!existing) await createWorkspaceWithAdmin({ workspaceName, adminName: "Workspace Administrator", adminEmail: email, password });
    bootstrapChecked = true;
  });
  try { await bootstrapPromise; }
  catch (error) { bootstrapPromise = undefined; throw error; }
}
