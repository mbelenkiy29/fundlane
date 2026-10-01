import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { assertStrictPlatformMutation, listSuperAdminActions, withSuperAdminAction } from "@/lib/mca/platform-audit"
import { requirePlatformStepUp } from "@/lib/mca/platform-step-up"
import { apiError } from "@/lib/mca/errors"

function csvCell(value: unknown): string {
  const safe = String(value ?? "").replace(/^[\s]*[=+@\-]/, "'$&")
  return `"${safe.replaceAll('"','""')}"`
}
export async function POST(request: Request) {
  try {
    const actor = await requireSuperAdmin(request)
    assertStrictPlatformMutation(request)
    assertTrustedMutation(request)
    await consumeRequestRateLimit(`platform-audit-export:${actor.userId}`, 5)
    const stepUpAt = await requirePlatformStepUp(actor)
    const data = await request.formData()
    const read = (key:string) => String(data.get(key) ?? "").slice(0,200)
    const filters = {actor:read("actor"),action:read("action"),workspace:read("workspace"),from:read("from"),to:read("to")}
    const rows = []
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = await listSuperAdminActions({...filters,offset})
      rows.push(...page)
      if (page.length < 100) break
    }
    await withSuperAdminAction({actor,action:"super_admin.audit_export",stepUpAt,request,after:{rowCount:rows.length}},async () => undefined)
    const header = ["created_at","actor_email","action","workspace_id","target_type","target_id","reason"]
    const body = [header.join(","),...rows.map(row=>[row.created_at,row.actor_email,row.action,row.target_workspace_id,row.target_type,row.target_id,row.reason].map(csvCell).join(","))].join("\r\n")
    return new Response(body,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=platform-admin-audit.csv","Cache-Control":"no-store"}})
  } catch (error) { return apiError(error) }
}
