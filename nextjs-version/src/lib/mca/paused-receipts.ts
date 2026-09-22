import "server-only"
import { createHash } from "node:crypto"
import { getCompanyAccess } from "./company-access"
import { encryptSensitive } from "./crypto"
import { getDatabase, nowIso } from "./db"

/** Call only after authenticating the provider and binding the original resource.
 * Keep evidence without advancing business state. Recovery requires an explicit
 * provider redelivery/current-status refresh, never blind replay of old events.
 */
export async function retainReceiptIfPaused(input: { workspaceId: string; kind: string; resourceId: string; payload: unknown }): Promise<boolean> {
  if ((await getCompanyAccess(input.workspaceId)).allowed) return false
  const payload = JSON.stringify(input.payload)
  const id = createHash("sha256").update(JSON.stringify([input.workspaceId, input.kind, input.resourceId, payload])).digest("hex")
  await getDatabase().prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,source,action,resource_type,resource_id,metadata,correlation_id,created_at)
    VALUES(?,?,NULL,'system','company.paused_receipt',?,?,?, ?,?) ON CONFLICT(id) DO NOTHING`)
    .run(id, input.workspaceId, input.kind, input.resourceId, JSON.stringify({ payloadCipher: encryptSensitive(payload, input.workspaceId), requiresReview: true }), id, nowIso())
  return true
}
