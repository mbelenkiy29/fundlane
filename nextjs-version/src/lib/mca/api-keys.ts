import "server-only";

import { createOpaqueToken, hashOpaqueToken } from "./crypto";
import { AppError } from "./errors";
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "./db";
import type { ApiKeyCreated, ApiKeyScope, ApiKeySummary, MembershipContext } from "./types";
import { isActionAllowed } from "./policy";
import { getWorkspaceSettings } from "./workspaces";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  rate_limit_per_minute: number;
}

function mapKey(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseJson<ApiKeyScope[]>(row.scopes, []),
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    rateLimitPerMinute: row.rate_limit_per_minute,
  };
}

function secretWithPrefix(): { secret: string; prefix: string } {
  const prefix = createOpaqueToken(6);
  return { prefix, secret: `mca_${prefix}_${createOpaqueToken(32)}` };
}

export async function listApiKeys(workspaceId: string): Promise<ApiKeySummary[]> {
  return (await getDatabase().prepare<ApiKeyRow>(`SELECT id, name, prefix, scopes, expires_at, last_used_at, revoked_at,
    created_at, rate_limit_per_minute FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC`)
    .all(workspaceId)).map(mapKey);
}

export async function createApiKey(
  context: MembershipContext,
  input: { name: string; scopes: ApiKeyScope[]; expiresAt?: string | null; rateLimitPerMinute?: number },
): Promise<ApiKeyCreated> {
  if (!isActionAllowed(context.role, "manageApiKeys", (await getWorkspaceSettings(context.workspaceId)).actionVisibility)) {
    throw new AppError(403, "action_disabled", "API key management is disabled for this workspace.");
  }
  const id = newId();
  const createdAt = nowIso();
  const generated = secretWithPrefix();
  await getDatabase().prepare(`INSERT INTO api_keys
    (id, workspace_id, name, prefix, secret_hash, scopes, expires_at, last_used_at, revoked_at,
     rate_limit_per_minute, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`).run(
      id,
      context.workspaceId,
      input.name,
      generated.prefix,
      hashOpaqueToken(generated.secret),
      JSON.stringify(input.scopes),
      input.expiresAt ?? null,
      input.rateLimitPerMinute ?? 60,
      context.userId,
      createdAt,
    );
  await recordAuditEvent({ context, action: "api_key.created", resourceType: "api_key", resourceId: id, metadata: { scopes: input.scopes } });
  return {
    id,
    name: input.name,
    prefix: generated.prefix,
    scopes: input.scopes,
    expiresAt: input.expiresAt ?? null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt,
    rateLimitPerMinute: input.rateLimitPerMinute ?? 60,
    secret: generated.secret,
  };
}

export async function rotateApiKey(context: MembershipContext, id: string): Promise<ApiKeyCreated> {
  if (!isActionAllowed(context.role, "manageApiKeys", (await getWorkspaceSettings(context.workspaceId)).actionVisibility)) {
    throw new AppError(403, "action_disabled", "API key management is disabled for this workspace.");
  }
  const generated = secretWithPrefix();
  const summary = await withImmediateTransaction(async (database) => {
    const existing = await database.prepare<ApiKeyRow>(`SELECT id, name, prefix, scopes, expires_at, last_used_at, revoked_at,
      created_at, rate_limit_per_minute FROM api_keys WHERE id = ? AND workspace_id = ? FOR UPDATE`).get(id, context.workspaceId);
    if (!existing) throw new AppError(404, "api_key_not_found", "API key not found.");
    if (existing.revoked_at) throw new AppError(409, "api_key_revoked", "A revoked key cannot be rotated.");
    await database.prepare("UPDATE api_keys SET prefix = ?, secret_hash = ?, last_used_at = NULL WHERE id = ? AND workspace_id = ?")
      .run(generated.prefix, hashOpaqueToken(generated.secret), id, context.workspaceId);
    return mapKey({ ...existing, prefix: generated.prefix, last_used_at: null });
  });
  await recordAuditEvent({ context, action: "api_key.rotated", resourceType: "api_key", resourceId: id });
  return { ...summary, secret: generated.secret };
}

export async function revokeApiKey(context: MembershipContext, id: string): Promise<ApiKeySummary> {
  if (!isActionAllowed(context.role, "manageApiKeys", (await getWorkspaceSettings(context.workspaceId)).actionVisibility)) {
    throw new AppError(403, "action_disabled", "API key management is disabled for this workspace.");
  }
  const revoked = await withImmediateTransaction(async (database) => {
    const existing = await database.prepare<ApiKeyRow>(`SELECT id, name, prefix, scopes, expires_at, last_used_at, revoked_at,
      created_at, rate_limit_per_minute FROM api_keys WHERE id = ? AND workspace_id = ? FOR UPDATE`).get(id, context.workspaceId);
    if (!existing) throw new AppError(404, "api_key_not_found", "API key not found.");
    const revokedAt = existing.revoked_at ?? nowIso();
    await database.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ?").run(revokedAt, id, context.workspaceId);
    return mapKey({ ...existing, revoked_at: revokedAt });
  });
  await recordAuditEvent({ context, action: "api_key.revoked", resourceType: "api_key", resourceId: id });
  return revoked;
}
