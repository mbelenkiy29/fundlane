import "server-only"
import { createHash } from "node:crypto"
import { getDatabase, newId, withImmediateTransaction, type DbExecutor } from "./db"
import { AppError } from "./errors"
import type { SuperAdminActor } from "./platform-auth"

export type SuperAdminAction = {
  actor: SuperAdminActor
  action: string
  workspaceId?: string | null
  targetType?: string | null
  targetId?: string | null
  reason?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  request?: Request
  stepUpAt?: string | null
}

function digest(value: string | null): string | null {
  return value ? createHash("sha256").update(value).digest("hex") : null
}

export async function insertSuperAdminAudit(input: SuperAdminAction, db: DbExecutor = getDatabase()): Promise<void> {
  const headers = input.request?.headers
  await db.prepare(`INSERT INTO platform_admin_audit
    (id, actor_user_id, actor_email, session_id, action, target_workspace_id, target_type, target_id,
     reason, before_json, after_json, step_up_at, request_id, ip_hash, user_agent_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?)`).run(
    newId(), input.actor.userId, input.actor.email, input.actor.sessionId, input.action,
    input.workspaceId ?? null, input.targetType ?? null, input.targetId ?? null, input.reason ?? null,
    input.before ? JSON.stringify(input.before) : null, input.after ? JSON.stringify(input.after) : null,
    input.stepUpAt ?? null, headers?.get("x-request-id") ?? null,
    digest(headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ?? headers?.get("x-real-ip") ?? null),
    digest(headers?.get("user-agent") ?? null),
  )
}

/** Nested service transactions share this executor; an audit insert failure rolls back their writes. */
export function withSuperAdminAction<T>(input: SuperAdminAction, action: (db: DbExecutor) => Promise<T>): Promise<T> {
  return withImmediateTransaction(async db => {
    const result = await action(db)
    await insertSuperAdminAudit(input, db)
    return result
  })
}

export async function recordFirstSuperAdminAccess(actor: SuperAdminActor): Promise<void> {
  await getDatabase().prepare(`INSERT INTO platform_admin_audit
    (id,actor_user_id,actor_email,session_id,action)
    VALUES (?,?,?,?,'super_admin.first_access') ON CONFLICT DO NOTHING`).run(newId(),actor.userId,actor.email,actor.sessionId)
}

export function assertStrictPlatformMutation(request: Request): void {
  if (!request.headers.get("origin")) throw new AppError(403,"untrusted_origin","An Origin header is required.")
}

export type PlatformAuditRow = {id:string;actor_user_id:string;actor_email:string;action:string;target_workspace_id:string|null;target_type:string|null;target_id:string|null;reason:string|null;created_at:string}
export async function listSuperAdminActions(query: {actor?:string;action?:string;workspace?:string;from?:string;to?:string;offset?:number}): Promise<PlatformAuditRow[]> {
  const date = (value?:string, end=false) => {
    if (!value) return ""
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)))
      throw new AppError(422,"invalid_query","Invalid audit date filter.")
    return new Date(Date.parse(`${value}T00:00:00.000Z`)+(end?86400000:0)).toISOString()
  }
  const from=date(query.from),to=date(query.to,true)
  if (from && to && from >= to) throw new AppError(422,"invalid_query","Start date must not follow end date.")
  return getDatabase().prepare<PlatformAuditRow>(`SELECT id,actor_user_id,actor_email,action,target_workspace_id,target_type,target_id,reason,created_at
    FROM platform_admin_audit WHERE (?='' OR actor_email ILIKE ?) AND (?='' OR action ILIKE ?)
    AND (?='' OR target_workspace_id=?) AND (?='' OR created_at>=NULLIF(?,'')::timestamptz)
    AND (?='' OR created_at<NULLIF(?,'')::timestamptz) ORDER BY created_at DESC,id LIMIT 100 OFFSET ?`).all(
    query.actor??"",`%${query.actor??""}%`,query.action??"",`%${query.action??""}%`,
    query.workspace??"",query.workspace??"",from,from,to,to,Math.min(100000,Math.max(0,query.offset??0)))
}
