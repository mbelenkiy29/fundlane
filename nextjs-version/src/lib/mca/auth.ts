import "server-only";
import { authenticateSupabaseSession } from "./supabase-auth";

import { AppError } from "./errors";
import { nowIso, parseJson, withImmediateTransaction } from "./db";
import { hashOpaqueToken } from "./crypto";
import type { ApiKeyScope, AuthContext, MembershipContext, Role } from "./types";

export const SESSION_COOKIE_NAME = "mca_session";

interface AccessOptions {
  roles?: readonly Role[];
  scopes?: readonly ApiKeyScope[];
  anyScopes?: readonly ApiKeyScope[];
  sessionOnly?: boolean;
}

/** Legacy cookies are deliberately rejected after the Supabase cutover. */
export async function authenticateSessionToken(_token: string): Promise<MembershipContext | null> {
  void _token;
  return null;
}

async function consumeApiKey(token: string): Promise<AuthContext | null> {
  const now = nowIso();
  return withImmediateTransaction(async (database) => {
    const row = await database.prepare<Record<string, string | number | null>>(`SELECT id, workspace_id, scopes, expires_at, rate_limit_per_minute
      FROM api_keys WHERE secret_hash = ? AND revoked_at IS NULL`).get(hashOpaqueToken(token));
    if (!row || (row.expires_at && String(row.expires_at) <= now)) return null;
    const bucket = Math.floor(Date.now() / 60_000);
    const count = await database.prepare<{ request_count: number }>(`INSERT INTO api_rate_windows (api_key_id, bucket_start, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(api_key_id, bucket_start) DO UPDATE SET request_count = api_rate_windows.request_count + 1
      RETURNING request_count`).get(row.id, bucket);
    if (!count) throw new Error("API rate counter did not return a row.");
    if (count.request_count > Number(row.rate_limit_per_minute)) {
      throw new AppError(429, "rate_limit_exceeded", "API key rate limit exceeded. Retry after the current minute.");
    }
    await database.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, row.id);
    await database.prepare("DELETE FROM api_rate_windows WHERE bucket_start < ?").run(bucket - 2);
    return {
      authType: "api_key",
      apiKeyId: String(row.id),
      userId: null,
      membershipId: null,
      workspaceId: String(row.workspace_id),
      role: null,
      scopes: parseJson<ApiKeyScope[]>(row.scopes, []),
      sessionId: null,
    };
  });
}

export async function authenticateRequest(request: Request): Promise<AuthContext | null> {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer mca_")) return consumeApiKey(authorization.slice(7));
  return authenticateSupabaseSession(request);
}

export async function requireWorkspaceAccess(request: Request, options: AccessOptions = {}): Promise<AuthContext> {
  const context = await authenticateRequest(request);
  if (!context) throw new AppError(401, "authentication_required", "Sign in to continue.");
  if (options.sessionOnly && context.authType !== "session") {
    throw new AppError(403, "session_required", "This action requires an interactive user session.");
  }
  if (options.roles?.length) {
    if (!context.role || !options.roles.includes(context.role)) {
      throw new AppError(403, "permission_denied", "You do not have permission to perform this action.");
    }
  }
  if (options.scopes?.length) {
    if (context.authType === "api_key" && options.scopes.some((scope) => !context.scopes.includes(scope))) {
      throw new AppError(403, "scope_required", "The API key does not have the required scope.");
    }
  }
  if (options.anyScopes?.length && context.authType === "api_key" && !options.anyScopes.some((scope) => context.scopes.includes(scope))) {
    throw new AppError(403, "scope_required", "The API key does not have a required scope.");
  }
  return context;
}

export async function requireMembershipAccess(request: Request, roles?: readonly Role[]): Promise<MembershipContext> {
  const context = await requireWorkspaceAccess(request, { sessionOnly: true, roles });
  return context as MembershipContext;
}

export function assertTrustedMutation(request: Request): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") throw new AppError(403, "untrusted_origin", "Cross-site requests are not allowed.");
  if (!origin) return; // Non-browser clients do not always send Origin.
  const allowed = new Set([
    new URL(request.url).origin,
    ...(process.env.MCA_APP_ORIGIN ? [new URL(process.env.MCA_APP_ORIGIN).origin] : []),
    ...(process.env.MCA_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ]);
  if (!allowed.has(origin)) throw new AppError(403, "untrusted_origin", "Request origin is not allowed.");
}

export async function consumeRequestRateLimit(key: string, limit: number): Promise<void> {
  await withImmediateTransaction(async (database) => {
    const bucket = Math.floor(Date.now() / 60_000);
    const row = await database.prepare<{ request_count: number }>(`INSERT INTO request_rate_windows (rate_key, bucket_start, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(rate_key, bucket_start) DO UPDATE SET request_count = request_rate_windows.request_count + 1
      RETURNING request_count`).get(key, bucket);
    if (!row) throw new Error("Request rate counter did not return a row.");
    if (row.request_count > limit) throw new AppError(429, "rate_limit_exceeded", "Too many attempts. Try again shortly.");
    await database.prepare("DELETE FROM request_rate_windows WHERE bucket_start < ?").run(bucket - 2);
  });
}

export function clientRateKey(request: Request, action: string): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "unknown";
  return `${action}:${hashOpaqueToken(address)}`;
}
