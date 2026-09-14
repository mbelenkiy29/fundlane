import "server-only"
import { assertTrustedMutation, requireMembershipAccess } from "../auth"
import { getSessionResponse } from "../sessions"
import { actorForDeals, getDealForDocument, listDeals } from "../deals/service"
import { permittedAssignmentIds } from "../deals/access-policy"
import type { DealActor } from "../deals/schema"
import { getDatabase, newId, nowIso, recordAuditEvent, withTransaction } from "../db"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { AppError } from "../errors"
import { followupOccurrenceFor, type FollowupLocalSchedule } from "../comms/followups"
import { activitySchema, dateInZone, type ActivityInput, type CalendarEvent, type CalendarFeed } from "./contracts"

export interface ActivityRow {
  id: string; workspace_id: string; deal_id: string; assignee_id: string; kind: ActivityInput["kind"];
  title: string; starts_at: string; ends_at: string; all_day: number; timezone: string; notes_cipher: string | null;
  status: ActivityInput["status"]; version: number; created_by: string; created_at: string; updated_at: string
}
export async function calendarActor(request: Request, mutation = false): Promise<DealActor> {
  if (mutation) assertTrustedMutation(request)
  const context = await requireMembershipAccess(request)
  const session = await getSessionResponse(context)
  if (!session.permissions?.pages.deals) throw new AppError(403, "calendar_forbidden", "Calendar access is disabled for this account.")
  return actorForDeals(context)
}
export function activityEvent(row: ActivityRow, editable: boolean): CalendarEvent {
  return { id: row.id, kind: row.kind, title: row.title, start: row.starts_at, end: row.ends_at, allDay: Boolean(row.all_day),
    timezone: row.timezone, status: row.status, editable, dealId: row.deal_id, assigneeId: row.assignee_id,
    notes: row.notes_cipher ? decryptSensitive(row.notes_cipher, row.workspace_id) : "", version: row.version,
    href: `/pipeline?deal=${encodeURIComponent(row.deal_id)}&tab=schedule` }
}
export function canEditActivity(actor: DealActor, row: ActivityRow): boolean {
  return actor.role === "admin" || actor.role === "super_admin" || permittedAssignmentIds(actor).has(row.assignee_id)
}
export async function wakeCalendar(workspaceId: string): Promise<void> {
  await getDatabase().prepare("UPDATE mca_calendar_connections SET next_sync_at=? WHERE workspace_id=? AND status<>'reconnect'").run(nowIso(), workspaceId)
}
export async function saveActivity(actor: DealActor, raw: unknown, id?: string): Promise<CalendarEvent> {
  const parsed = activitySchema.safeParse(raw)
  if (!parsed.success) throw new AppError(422, "invalid_activity", "Check the schedule details.", parsed.error.flatten().fieldErrors)
  const input = parsed.data
  return withTransaction(async db => {
    await db.prepare("SELECT id FROM mca_calendar_connections WHERE workspace_id=? ORDER BY id FOR UPDATE").all(actor.workspaceId)
    const old = id ? await db.prepare<ActivityRow>("SELECT * FROM mca_calendar_activities WHERE workspace_id=? AND id=? FOR UPDATE").get(actor.workspaceId, id) : undefined
    if (id && !old) throw new AppError(404, "activity_not_found", "Activity not found.")
    if (old) {
      await getDealForDocument(actor, old.deal_id)
      if (!canEditActivity(actor, old)) throw new AppError(403, "activity_forbidden", "You cannot change this person's activity.")
      if (input.version !== old.version) throw new AppError(409, "activity_conflict", "This activity changed. Reload it before saving.")
      if (input.dealId !== old.deal_id || input.kind !== old.kind) throw new AppError(422, "activity_identity", "An activity's deal and type cannot be changed.")
    }
    await getDealForDocument(actor, input.dealId)
    if (!actor.activeMembershipIds.includes(input.assigneeId) || !permittedAssignmentIds(actor).has(input.assigneeId)) throw new AppError(403, "assignee_forbidden", "Choose an authorized active assignee.")
    const member = await db.prepare<{ user_id: string; role: DealActor["role"] }>("SELECT user_id,role FROM memberships WHERE id=? AND workspace_id=? AND status='active'").get(input.assigneeId, actor.workspaceId)
    if (!member) throw new AppError(422, "assignee_inactive", "Choose an active member.")
    const target = await actorForDeals({ authType: "session", userId: member.user_id, workspaceId: actor.workspaceId, membershipId: input.assigneeId, role: member.role, scopes: [], sessionId: null })
    await getDealForDocument(target, input.dealId)
    const now = nowIso()
    const start = input.allDay ? input.start : new Date(input.start).toISOString()
    const end = input.allDay ? input.end : new Date(input.end).toISOString()
    const recordId = old?.id ?? newId()
    if (old) {
      await db.prepare(`UPDATE mca_calendar_activities SET assignee_id=?,title=?,starts_at=?,ends_at=?,all_day=?,timezone=?,notes_cipher=?,status=?,version=version+1,updated_at=? WHERE id=? AND workspace_id=?`).run(input.assigneeId,input.title,start,end,Number(input.allDay),input.timezone,encryptSensitive(input.notes,actor.workspaceId),input.status,now,recordId,actor.workspaceId)
    } else {
      await db.prepare(`INSERT INTO mca_calendar_activities (id,workspace_id,deal_id,assignee_id,kind,title,starts_at,ends_at,all_day,timezone,notes_cipher,status,version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(recordId,actor.workspaceId,input.dealId,input.assigneeId,input.kind,input.title,start,end,Number(input.allDay),input.timezone,encryptSensitive(input.notes,actor.workspaceId),input.status,actor.userId,now,now)
    }
    await wakeCalendar(actor.workspaceId)
    await recordAuditEvent({ context: actor, action: old ? "calendar.activity_updated" : "calendar.activity_created", resourceType: "calendar_activity", resourceId: recordId, metadata: { dealId: input.dealId, status: input.status }, executor: db })
    return activityEvent((await db.prepare<ActivityRow>("SELECT * FROM mca_calendar_activities WHERE id=?").get(recordId))!,true)
  })
}

export function calendarRange(from: string | null, to: string | null): { from: string; to: string } {
  if (!from || !to || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from) || Date.parse(to)-Date.parse(from)>93*86400000) throw new AppError(422,"invalid_calendar_range","Choose a date range of at most 93 days.")
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}
export function projectFollowups(schedule: FollowupLocalSchedule, from: string, to: string) {
  const result = new Map<string, NonNullable<ReturnType<typeof followupOccurrenceFor>>>()
  for (let ms=Date.parse(from)-86400000*2; ms<Date.parse(to)+86400000*2; ms+=86400000) {
    const occurrence=followupOccurrenceFor(schedule,new Date(ms).toISOString())
    if (occurrence && occurrence.scheduledFor>=from && occurrence.scheduledFor<to) result.set(occurrence.occurrenceKey,occurrence)
  }
  return [...result.values()]
}
export async function calendarFeed(actor: DealActor, query: URLSearchParams): Promise<CalendarFeed> {
  const { from,to }=calendarRange(query.get("from"),query.get("to"))
  const team=query.get("scope")==="team"
  const canViewTeam=actor.role!=="rep"
  if (team && !canViewTeam) throw new AppError(403,"calendar_team_forbidden","Team calendar access requires a manager.")
  const db=getDatabase()
  const visible=(await listDeals(actor,{})).deals.filter(d=>!query.get("dealId") || d.id===query.get("dealId"))
  const dealMap=new Map(visible.map(d=>[d.id,d]))
  const assignedDeals=visible.filter(d=>team || d.assignments.some(a=>a.membershipId===actor.membershipId))
  const assignedMap=new Map(assignedDeals.map(d=>[d.id,d]))
  const activities=await db.prepare<ActivityRow>(`SELECT * FROM mca_calendar_activities WHERE workspace_id=? AND starts_at<? AND ends_at>? ORDER BY starts_at,id`).all(actor.workspaceId,to,from.slice(0,10))
  const events: CalendarEvent[]=activities.filter(a=>dealMap.has(a.deal_id) && (team || a.assignee_id===actor.membershipId)).map(a=>({...activityEvent(a,canEditActivity(actor,a)),dealName:dealMap.get(a.deal_id)?.legalName}))
  const conflicts=await db.prepare<{activity_id:string;conflict_json:string}>(`SELECT l.activity_id,l.conflict_json FROM mca_calendar_event_links l JOIN mca_calendar_connections c ON c.id=l.connection_id WHERE c.workspace_id=? AND c.user_id=? AND l.conflict_json IS NOT NULL`).all(actor.workspaceId,actor.userId)
  for (const event of events) { const c=conflicts.find(c=>c.activity_id===event.id); if(c) event.conflict=JSON.parse(c.conflict_json) }
  const submissions=await db.prepare<{id:string;deal_id:string;display_funder_name:string;sent_at:string;estimated:boolean}>(`SELECT j.id,j.deal_id,j.display_funder_name,MIN(COALESCE(a.sent_at,j.updated_at)) sent_at,BOOL_OR(a.sent_at IS NULL) estimated FROM mca_submission_jobs j JOIN mca_submission_attempts a ON a.job_id=j.id AND a.workspace_id=j.workspace_id AND a.state='sent' WHERE j.workspace_id=? GROUP BY j.id HAVING MIN(COALESCE(a.sent_at,j.updated_at))>=? AND MIN(COALESCE(a.sent_at,j.updated_at))<?`).all(actor.workspaceId,from,to)
  for (const row of submissions) if(assignedMap.has(row.deal_id)) events.push({id:`submission:${row.id}`,kind:"submission",title:`Submitted to ${row.display_funder_name}`,notes:row.estimated?"Legacy submission: this date uses the last recorded job update because a delivery timestamp was not retained.":undefined,start:row.sent_at,end:new Date(Date.parse(row.sent_at)+60000).toISOString(),allDay:false,timezone:"UTC",status:"sent",editable:false,dealId:row.deal_id,dealName:assignedMap.get(row.deal_id)?.legalName,href:`/pipeline?deal=${encodeURIComponent(row.deal_id)}&tab=submissions`})
  const history=await db.prepare<{policy_id:string;deal_id:string;occurrence_key:string;scheduled_for:string;state:string;channel:string}>(`SELECT o.*,p.channel FROM mca_followup_occurrences o JOIN mca_followup_policies p ON p.id=o.policy_id AND p.workspace_id=o.workspace_id WHERE o.workspace_id=? AND o.scheduled_for>=? AND o.scheduled_for<?`).all(actor.workspaceId,from,to)
  const seen=new Set<string>()
  const addFollowup=(policyId:string,dealId:string,key:string,start:string,status:string,channel:string,timezone="UTC")=>{
    const id=`auto:${policyId}:${dealId}:${key}`
    if(seen.has(id)) return
    seen.add(id)
    events.push({id,kind:"automated_followup",title:`Automated ${channel} follow-up`,start,end:new Date(Date.parse(start)+60000).toISOString(),allDay:false,timezone,status,editable:false,dealId,dealName:assignedMap.get(dealId)?.legalName,href:`/pipeline?deal=${encodeURIComponent(dealId)}&tab=messages`})
  }
  for(const row of history) if(assignedMap.has(row.deal_id)) addFollowup(row.policy_id,row.deal_id,row.occurrence_key,row.scheduled_for,row.state,row.channel)
  const policies=await db.prepare<{id:string;deal_status:string;channel:string;local_schedule:string}>("SELECT id,deal_status,channel,local_schedule FROM mca_followup_policies WHERE workspace_id=? AND enabled=1").all(actor.workspaceId)
  for(const policy of policies) {
    const schedule=JSON.parse(policy.local_schedule) as FollowupLocalSchedule
    for(const occurrence of projectFollowups({...schedule,minute:schedule.minute??0},from,to)) {
      if(occurrence.scheduledFor<nowIso()) continue
      for(const deal of assignedDeals) if(deal.status===policy.deal_status) addFollowup(policy.id,deal.id,occurrence.occurrenceKey,occurrence.scheduledFor,"scheduled",policy.channel,schedule.timezone)
    }
  }
  if(!query.get("dealId")) {
    const overlays=await db.prepare<{event_cipher:string}>(`SELECT e.event_cipher FROM mca_calendar_external_events e JOIN mca_calendar_connections c ON c.id=e.connection_id JOIN mca_calendar_sources s ON s.connection_id=e.connection_id AND s.calendar_id=e.calendar_id WHERE c.workspace_id=? AND c.user_id=? AND s.selected=1`).all(actor.workspaceId,actor.userId)
    for(const row of overlays) {
      const event=JSON.parse(decryptSensitive(row.event_cipher,actor.workspaceId)) as CalendarEvent
      if(event.start<to && event.end>from.slice(0,10)) events.push(event)
    }
  }
  const allowed=permittedAssignmentIds(actor)
  const members=await db.prepare<{id:string;name:string}>("SELECT m.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.status='active' ORDER BY u.name").all(actor.workspaceId)
  const workspace=await db.prepare<{timezone:string}>("SELECT timezone FROM workspaces WHERE id=?").get(actor.workspaceId)
  const timezone=workspace?.timezone??"America/New_York"
  const overlapping=events.filter(e=>e.allDay ? e.start<=dateInZone(new Date(Date.parse(to)-1),timezone) && e.end>dateInZone(from,timezone) : e.start<to && e.end>from)
  return {events:overlapping.sort((a,b)=>a.start.localeCompare(b.start)),deals:visible.map(d=>({id:d.id,name:d.legalName||d.displayId,assigneeIds:d.assignments.map(a=>a.membershipId)})),assignees:members.filter(m=>allowed.has(m.id)),membershipId:actor.membershipId!,canViewTeam,timezone:workspace?.timezone??"America/New_York"}
}
