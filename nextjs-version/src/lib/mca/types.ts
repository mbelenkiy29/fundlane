export const ROLES = ["rep", "manager", "admin", "super_admin"] as const;
export type Role = (typeof ROLES)[number];

export const MEMBERSHIP_STATUSES = ["pending", "active", "deactivated"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const API_KEY_SCOPES = [
  "deals:read",
  "deals:write",
  "deals:export",
  "intake:write",
  "workspace:read",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const PAGE_KEYS = [
  "dashboard",
  "deals",
  "users",
  "reports",
  "payments",
  "workspace",
  "integrations",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export interface FeatureFlags {
  reports: boolean;
  payments: boolean;
  integrations: boolean;
}

export interface PageVisibility {
  dashboard: boolean;
  deals: boolean;
  users: boolean;
  reports: boolean;
  payments: boolean;
  workspace: boolean;
  integrations: boolean;
}

export interface ActionVisibility {
  createDeal: boolean;
  exportDeals: boolean;
  inviteUsers: boolean;
  manageApiKeys: boolean;
  viewPaymentTable: boolean;
  viewCompanyFinancials: boolean;
}

export interface WorkspaceSettings {
  workspaceId: string;
  brokerageName: string;
  logoUrl: string | null;
  timezone: string;
  seatLimit: number;
  seatLimitManaged?: boolean;
  featureFlags: FeatureFlags;
  pageVisibility: PageVisibility;
  actionVisibility: ActionVisibility;
  updatedAt: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  applicationIdentifier: string;
}

export interface AuthContext {
  authType: "session" | "api_key";
  userId: string | null;
  membershipId: string | null;
  workspaceId: string;
  role: Role | null;
  scopes: readonly ApiKeyScope[];
  sessionId: string | null;
}

export interface MembershipContext extends AuthContext {
  authType: "session";
  userId: string;
  membershipId: string;
  role: Role;
}

export interface SessionResponse {
  authenticated: boolean;
  user?: SessionUser;
  membership?: {
    id: string;
    workspaceId: string;
    workspaceName: string;
    role: Role;
    managerMembershipId: string | null;
  };
  permissions?: {
    pages: PageVisibility;
    actions: ActionVisibility;
    canManageUsers: boolean;
    canManageWorkspace: boolean;
    canManageApiKeys: boolean;
    canViewCompanyFinancials: boolean;
    canAccessPayments: boolean;
  };
}

export interface MembershipSummary {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  email: string;
  phone: string | null;
  applicationIdentifier: string;
  senderAssociation: string | null;
  role: Role;
  managerMembershipId: string | null;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
  pendingInvitationId: string | null;
  invitationExpiresAt: string | null;
  invitationDeliveryStatus: "pending" | "sent" | "preview" | "failed" | null;
}

export interface InvitationResult {
  id: string;
  membershipId: string;
  email: string;
  expiresAt: string;
  delivery: "sent" | "preview";
  previewUrl?: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  rateLimitPerMinute: number;
}

export interface ApiKeyCreated extends ApiKeySummary {
  secret: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    correlationId?: string;
  };
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  source: "user" | "api_key" | "system";
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  correlationId: string;
  createdAt: string;
}

export interface WorkspaceResource {
  id: string;
  workspaceId: string;
}

export interface JobResourceReference {
  workspaceId: string;
  resourceType: string;
  resourceId: string;
}
