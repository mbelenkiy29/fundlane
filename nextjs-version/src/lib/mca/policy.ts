import type { ActionVisibility, FeatureFlags, PageKey, PageVisibility, Role } from "./types";

const ROLE_PAGES: Record<Role, ReadonlySet<PageKey>> = {
  rep: new Set(["dashboard", "deals", "payments"]),
  manager: new Set(["dashboard", "deals", "payments"]),
  admin: new Set(["dashboard", "deals", "users", "reports", "payments", "workspace", "integrations"]),
  super_admin: new Set(["dashboard", "deals", "users", "reports", "payments", "workspace", "integrations"]),
};

export function roleAtLeast(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}

export function canManageUsers(role: Role): boolean {
  return role === "admin" || role === "super_admin";
}

export function canManageWorkspace(role: Role): boolean {
  return role === "admin" || role === "super_admin";
}

export function canManageApiKeys(role: Role): boolean {
  return role === "admin" || role === "super_admin";
}

export function canViewCompanyFinancials(role: Role): boolean {
  return role === "admin" || role === "super_admin";
}

export function canAccessPayments(role: Role): boolean {
  return role === "admin" || role === "super_admin";
}

export function effectivePageVisibility(
  role: Role,
  configured: PageVisibility,
  features: FeatureFlags,
): PageVisibility {
  const allowed = ROLE_PAGES[role];
  return {
    dashboard: configured.dashboard && allowed.has("dashboard"),
    deals: configured.deals && allowed.has("deals"),
    users: configured.users && allowed.has("users"),
    reports: configured.reports && features.reports && allowed.has("reports"),
    payments: configured.payments && features.payments && allowed.has("payments"),
    workspace: configured.workspace && allowed.has("workspace"),
    integrations: configured.integrations && features.integrations && allowed.has("integrations"),
  };
}

export function effectiveActionVisibility(role: Role, configured: ActionVisibility): ActionVisibility {
  const administrative = role === "admin" || role === "super_admin";
  return {
    createDeal: configured.createDeal,
    exportDeals: configured.exportDeals,
    inviteUsers: configured.inviteUsers && administrative,
    manageApiKeys: configured.manageApiKeys && administrative,
    viewPaymentTable: configured.viewPaymentTable && administrative,
    viewCompanyFinancials: configured.viewCompanyFinancials && administrative,
  };
}

export function isActionAllowed(
  role: Role,
  action: keyof ActionVisibility,
  configured: ActionVisibility,
): boolean {
  return effectiveActionVisibility(role, configured)[action];
}

export function visibleDealOwnerMembershipIds(
  role: Role,
  membershipId: string,
  managedMembershipIds: readonly string[],
): readonly string[] | null {
  if (role === "admin" || role === "super_admin") return null;
  if (role === "manager") return [membershipId, ...managedMembershipIds];
  return [membershipId];
}
