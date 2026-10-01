import "server-only"
import { z } from "zod"
import { getDatabase } from "./db"
import { AppError } from "./errors"
import { requireSuperAdmin, type SuperAdminActor } from "./platform-auth"
import { getCompanyAccess } from "./company-access"
import { ownerQueueQuerySchema, type OwnerQueueQuery, type CompanyOperationsRow, type SmsReviewItem, type Page, type RegistrationSummary } from "./platform-contracts"

const cursorSchema = z.object({ stamp: z.string().min(1).max(100), id: z.string().min(1).max(200), workspaceId: z.string(), state: z.string(), kind: z.enum(["companies","sms"]) }).strict()
type Row = { id:string; name:string; created_at:string; owner_email:string|null; occupied_seats:number; purchased_seats:number; subscription_status:string|null; review_state:string; submitted_at:string|null; suspended:number; registrations:RegistrationSummary[] }
async function readQueue(actor:SuperAdminActor, input:OwnerQueueQuery, kind:"companies"|"sms") {
  const live=await requireSuperAdmin()
  if(live.userId!==actor.userId||live.sessionId!==actor.sessionId||live.supabaseUserId!==actor.supabaseUserId) throw new AppError(403,"super_admin_required","Platform access required.")
  const parsed=ownerQueueQuerySchema.safeParse(input)
  if(!parsed.success) throw new AppError(422,"invalid_query","Invalid queue filters.")
  const query=parsed.data
  let cursor:z.infer<typeof cursorSchema>|undefined
  if(query.cursor) {
    try { cursor=cursorSchema.parse(JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8"))) } catch { throw new AppError(422,"invalid_query","Invalid queue cursor.") }
    if(cursor.workspaceId!==(query.workspaceId??"")||cursor.state!==(query.state??"")||cursor.kind!==kind) throw new AppError(422,"invalid_query","Restart pagination after changing filters.")
  }
  // Filters and immutable creation/ID cursor precede the bounded limit. No private payloads are selected.
  const rows=await getDatabase().prepare<Row>(`SELECT w.id,w.name,w.created_at,
    (SELECT u.email FROM workspace_owners o JOIN memberships m ON m.id=o.membership_id AND m.workspace_id=o.workspace_id JOIN users u ON u.id=m.user_id WHERE o.workspace_id=w.id) owner_email,
    (SELECT count(*)::int FROM memberships m WHERE m.workspace_id=w.id AND m.status IN ('active','pending')) occupied_seats,
    CASE WHEN e.status IS NOT NULL THEN w.seat_limit ELSE 0 END purchased_seats,e.status subscription_status,
    COALESCE(c.review_state,'not_started') review_state,c.submitted_at,COALESCE(c.suspended,0) suspended,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'kind',r.kind,'attempt',r.attempt,'state',
      CASE WHEN r.provider_status IN ('not_started','pending','approved','rejected') AND r.status=r.provider_status THEN r.status ELSE 'unknown' END) ORDER BY r.kind)
      FROM (SELECT DISTINCT ON (kind) id,kind,attempt,status,provider_status FROM sms_registrations WHERE workspace_id=w.id ORDER BY kind,attempt DESC,id DESC) r),'[]'::jsonb) registrations
    FROM workspaces w LEFT JOIN sms_companies c ON c.workspace_id=w.id LEFT JOIN workspace_billing_entitlements e ON e.workspace_id=w.id
    WHERE (?='' OR w.id=?) AND (?='' OR COALESCE(c.review_state,'not_started')=?) AND (?='companies' OR c.workspace_id IS NOT NULL)
    AND (?='' OR (w.created_at,w.id)>(?,?)) ORDER BY w.created_at,w.id LIMIT ?`)
    .all(query.workspaceId??"",query.workspaceId??"",query.state??"",query.state??"",kind,cursor?.id??"",cursor?.stamp??"",cursor?.id??"",query.limit+1)
  const pageRows=rows.slice(0,query.limit),last=pageRows.at(-1)
  return {rows:pageRows,nextCursor:rows.length>query.limit&&last?Buffer.from(JSON.stringify({stamp:last.created_at,id:last.id,workspaceId:query.workspaceId??"",state:query.state??"",kind})).toString("base64url"):null}
}
function blockedReasons(row:Row) {return [...(row.suspended?["sms_suspended"]:[]),...(row.review_state!=="approved"?["sms_review_required"]:[]),"provider_observation_unverified"]}
export async function listCompanyOperations(actor:SuperAdminActor,query:OwnerQueueQuery):Promise<Page<CompanyOperationsRow>> {
  const page=await readQueue(actor,query,"companies")
  return {items:await Promise.all(page.rows.map(async row=>{
    const access=await getCompanyAccess(row.id)
    return {workspaceId:row.id,name:row.name,ownerEmail:row.owner_email,occupiedSeats:row.occupied_seats,purchasedSeats:row.purchased_seats,subscriptionStatus:row.subscription_status??"none",accessState:access.status,smsReviewState:row.review_state,
      // Legacy timestamps include local writes; they are not proven provider observations.
      providerState:"unknown",observedAt:null,blockedReasons:[...(!access.allowed&&access.reason?[access.reason]:[]),...blockedReasons(row)]}
  })),nextCursor:page.nextCursor}
}
export async function listSmsReviewQueue(actor:SuperAdminActor,query:OwnerQueueQuery):Promise<Page<SmsReviewItem>> {
  const page=await readQueue(actor,query,"sms")
  return {items:page.rows.map(row=>({workspaceId:row.id,companyName:row.name,submissionId:null,version:null,reviewState:row.review_state,submittedAt:row.submitted_at,registrationSummary:row.registrations,blockedReasons:blockedReasons(row)})),nextCursor:page.nextCursor}
}
