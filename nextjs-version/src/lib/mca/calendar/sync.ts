import "server-only"
import { createHash } from "node:crypto"
import { getDatabase, nowIso, withTransaction, recordAuditEvent, newId } from "../db"
import { createOpaqueToken, encryptSensitive, hashOpaqueToken } from "../crypto"
import { getSessionResponse } from "../sessions"
import { actorForDeals, getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { getCompanyAccess } from "../company-access"
import { activitySchema, type CalendarEvent } from "./contracts"
import { type ActivityRow, canEditActivity } from "./service"
import { connectionFor, eventPath, googleEnabled, googleRequest, GoogleCalendarError, type Connection, type GoogleEvent } from "./google"

export interface SyncFields { title:string;start:string;end:string;allDay:boolean;timezone:string;cancelled:boolean }
interface Link { connection_id:string;activity_id:string;event_id:string;etag:string|null;local_version:number;baseline_json:string|null;conflict_json:string|null;resolution:"local"|"google"|null }
interface Source { calendar_id:string;name:string;selected:number;sync_token:string|null;channel_id:string|null;resource_id:string|null;channel_expires_at:string|null }
export function localFields(row:ActivityRow):SyncFields { return {title:row.title,start:row.starts_at,end:row.ends_at,allDay:Boolean(row.all_day),timezone:row.timezone,cancelled:row.status==="cancelled"} }
export function remoteFields(event:GoogleEvent,fallback?:SyncFields):SyncFields|undefined {
  if(event.status==="cancelled") return fallback?{...fallback,cancelled:true}:undefined
  const start=event.start?.date??event.start?.dateTime,end=event.end?.date??event.end?.dateTime
  if(!start || !end || event.recurrence?.length || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return undefined
  const fields={title:event.summary?.trim()||"Untitled event",start:event.start?.date?start:new Date(start).toISOString(),end:event.end?.date?end:new Date(end).toISOString(),allDay:Boolean(event.start?.date),timezone:event.start?.timeZone??fallback?.timezone??"UTC",cancelled:false}
  const {cancelled,...data}=fields
  const result=activitySchema.safeParse({...data,dealId:"external",assigneeId:"external",kind:"call"})
  return result.success?{...fields,cancelled}:undefined
}
export function sameFields(a:SyncFields,b:SyncFields):boolean { return a.title===b.title && a.start===b.start && a.end===b.end && a.allDay===b.allDay && a.timezone===b.timezone && a.cancelled===b.cancelled }
export function syncDecision(localChanged:boolean,remoteChanged:boolean,equal:boolean):"push"|"pull"|"conflict"|"none" {
  if(equal) return "none"
  if(localChanged && remoteChanged) return "conflict"
  return localChanged?"push":remoteChanged?"pull":"none"
}
export function stableEventId(connectionId:string,activityId:string,generation=0):string { return "f"+createHash("sha256").update(`${connectionId}:${activityId}:${generation}`).digest("hex") }
async function googleEvent(c:Connection,id:string):Promise<GoogleEvent|undefined> {
  try { return await googleRequest<GoogleEvent>(c,eventPath(c.calendar_id!,id)) } catch(error) { if(error instanceof GoogleCalendarError && [404,410].includes(error.status)) return undefined; throw error }
}
async function connectionActor(c:Connection):Promise<DealActor|undefined> {
  const member=await getDatabase().prepare<{role:DealActor["role"]}>("SELECT role FROM memberships WHERE id=? AND user_id=? AND workspace_id=? AND status='active'").get(c.membership_id,c.user_id,c.workspace_id)
  if(!member?.role) return undefined
  const context={authType:"session" as const,workspaceId:c.workspace_id,userId:c.user_id,membershipId:c.membership_id,role:member.role,scopes:[],sessionId:null}
  if(!(await getSessionResponse(context)).permissions?.pages.deals) return undefined
  return actorForDeals(context)
}
async function listSources(c:Connection):Promise<void> {
  const db=getDatabase()
  let page:string|undefined
  const seen=new Set<string>()
  const calendars:{id:string;summary?:string;description?:string;primary?:boolean;deleted?:boolean}[]=[]
  do {
    const result=await googleRequest<{items?:typeof calendars;nextPageToken?:string}>(c,"/users/me/calendarList?"+new URLSearchParams({maxResults:"250",...(page?{pageToken:page}:{})}))
    calendars.push(...result.items??[]);page=result.nextPageToken
  } while(page)
  if(!c.calendar_id) {
    // Recover a successful calendars.insert whose local commit was interrupted.
    const marker=`Fundlane connection ${c.id}`
    const found=calendars.find(item=>item.description===marker && !item.deleted)
    const owned=found??await googleRequest<{id:string;summary:string}>(c,"/calendars",{method:"POST",body:JSON.stringify({summary:"Fundlane",description:marker,timeZone:"UTC"})})
    c.calendar_id=owned.id
    await db.prepare("UPDATE mca_calendar_connections SET calendar_id=? WHERE id=?").run(owned.id,c.id)
    if(!found) calendars.push(owned)
  }
  for(const cal of calendars) {
    if(cal.deleted || cal.id===c.calendar_id) continue
    seen.add(cal.id)
    await db.prepare("INSERT INTO mca_calendar_sources (connection_id,calendar_id,name,selected) VALUES (?,?,?,?) ON CONFLICT(connection_id,calendar_id) DO UPDATE SET name=excluded.name").run(c.id,cal.id,cal.summary??"Google calendar",Number(Boolean(cal.primary)))
  }
  const previous=await db.prepare<Source>("SELECT * FROM mca_calendar_sources WHERE connection_id=?").all(c.id)
  for(const source of previous) if(source.calendar_id!==c.calendar_id && !seen.has(source.calendar_id)) {
    await db.prepare("DELETE FROM mca_calendar_sources WHERE connection_id=? AND calendar_id=?").run(c.id,source.calendar_id)
    await db.prepare("DELETE FROM mca_calendar_external_events WHERE connection_id=? AND calendar_id=?").run(c.id,source.calendar_id)
  }
  await db.prepare("INSERT INTO mca_calendar_sources (connection_id,calendar_id,name,selected) VALUES (?,?,'Fundlane',1) ON CONFLICT DO NOTHING").run(c.id,c.calendar_id)
}
function eventBody(row:ActivityRow,fields:SyncFields) {
  return {summary:fields.title,start:fields.allDay?{date:fields.start}:{dateTime:fields.start,timeZone:fields.timezone},end:fields.allDay?{date:fields.end}:{dateTime:fields.end,timeZone:fields.timezone},description:`Open in Fundlane: ${new URL(`/pipeline?deal=${encodeURIComponent(row.deal_id)}&tab=schedule`,process.env.MCA_APP_ORIGIN!).href}\nStatus: ${row.status}`,recurrence:[],transparency:row.status==="scheduled"?"opaque":"transparent",extendedProperties:{private:{fundlaneActivityId:row.id}},reminders:{useDefault:false,overrides:row.status==="scheduled"?[{method:"popup",minutes:10}]:[]}}
}
async function conflict(link:Link,remote:SyncFields|undefined,event:GoogleEvent|undefined,reason?:string) {
  await getDatabase().prepare("UPDATE mca_calendar_event_links SET conflict_json=?,resolution=NULL WHERE connection_id=? AND activity_id=?").run(JSON.stringify({...remote,etag:event?.etag??"deleted",reason}),link.connection_id,link.activity_id)
}
async function updateBaseline(link:Link,row:ActivityRow,event:GoogleEvent|undefined,fields:SyncFields) {
  await getDatabase().prepare("UPDATE mca_calendar_event_links SET event_id=?,etag=?,local_version=?,baseline_json=?,conflict_json=NULL,resolution=NULL WHERE connection_id=? AND activity_id=?").run(link.event_id,event?.etag??"deleted",row.version,JSON.stringify(fields),link.connection_id,link.activity_id)
}
async function reconcileActivity(c:Connection,actor:DealActor,row:ActivityRow,link:Link) {
  const db=getDatabase(),local=localFields(row)
  let event=await googleEvent(c,link.event_id)
  const baseline=link.baseline_json?JSON.parse(link.baseline_json) as SyncFields:undefined
  const remote=event?remoteFields(event,baseline??local):baseline?{...baseline,cancelled:true}:undefined
  if(event && !remote && !(link.resolution==="local" && link.conflict_json && JSON.parse(link.conflict_json).etag===event.etag)) { await conflict(link,local,event,"This Google event has an unsupported schedule. Remove recurrence or correct its dates in Google Calendar.");return }
  const localChanged=row.version!==link.local_version
  const remoteChanged=Boolean(baseline && remote && !sameFields(baseline,remote))
  let decision=syncDecision(localChanged,remoteChanged,Boolean(remote && sameFields(local,remote)))
  if(!baseline) decision="push"
  if(link.resolution && link.conflict_json) {
    const prior=JSON.parse(link.conflict_json) as {etag:string}
    if(prior.etag!==(event?.etag??"deleted")) { await conflict(link,remote,event,"Google changed again. Review the latest version.");return }
    decision=link.resolution==="local"?"push":"pull"
  }
  if(decision==="conflict") { await conflict(link,remote,event);return }
  if(decision==="pull" && remote) {
    // Deal linkage, assignment, notes and completion cannot be changed by Google.
    const status=row.status==="completed"?"completed":remote.cancelled?"cancelled":"scheduled"
    await db.prepare("UPDATE mca_calendar_activities SET title=?,starts_at=?,ends_at=?,all_day=?,timezone=?,status=?,version=version+1,updated_at=? WHERE id=? AND workspace_id=? AND version=?").run(remote.title,remote.start,remote.end,Number(remote.allDay),remote.timezone,status,nowIso(),row.id,c.workspace_id,row.version)
    row={...row,title:remote.title,starts_at:remote.start,ends_at:remote.end,all_day:Number(remote.allDay),timezone:remote.timezone,status,version:row.version+1}
    await recordAuditEvent({context:actor,action:"calendar.google_activity_updated",resourceType:"calendar_activity",resourceId:row.id,metadata:{status}})
    await updateBaseline(link,row,event,remote)
    return
  }
  if(decision==="push" || localChanged && decision==="none") {
    try {
      if(local.cancelled) {
        if(event && event.status!=="cancelled") await googleRequest(c,eventPath(c.calendar_id!,link.event_id)+"?sendUpdates=none",{method:"DELETE",headers:{"If-Match":event.etag!}})
        event=undefined
      } else if(!event || event.status==="cancelled") {
        if(baseline || event?.status==="cancelled") link.event_id=stableEventId(c.id,row.id,row.version)
        try { event=await googleRequest<GoogleEvent>(c,eventPath(c.calendar_id!)+"?sendUpdates=none",{method:"POST",body:JSON.stringify({...eventBody(row,local),id:link.event_id})}) }
        catch(error) {
          if(!(error instanceof GoogleCalendarError && error.status===409)) throw error
          event=await googleEvent(c,link.event_id)
          const existing=event && remoteFields(event,local)
          if(!event || !existing || !sameFields(existing,local)) { await conflict(link,existing,event,"The matching Google event changed during a retry.");return }
        }
      } else {
        event=await googleRequest<GoogleEvent>(c,eventPath(c.calendar_id!,link.event_id)+"?sendUpdates=none",{method:"PATCH",headers:{"If-Match":event.etag!},body:JSON.stringify(eventBody(row,local))})
      }
    } catch(error) {
      if(error instanceof GoogleCalendarError && error.status===412) { const latest=await googleEvent(c,link.event_id);await conflict(link,latest?remoteFields(latest,local):{...local,cancelled:true},latest,"Google changed while saving. Choose which version to keep.");return }
      throw error
    }
    await updateBaseline(link,row,event,local)
  } else if(remote) await updateBaseline(link,row,event,remote)
}
async function syncActivities(c:Connection,actor:DealActor) {
  const db=getDatabase()
  const rows=await db.prepare<ActivityRow>("SELECT * FROM mca_calendar_activities WHERE workspace_id=? AND assignee_id=? ORDER BY starts_at,id").all(c.workspace_id,c.membership_id)
  const visible=new Map<string,ActivityRow>()
  for(const row of rows) {
    try { await getDealForDocument(actor,row.deal_id);visible.set(row.id,row) } catch(error) { if(!(error instanceof AppError && error.status===404)) throw error }
  }
  const links=await db.prepare<Link>("SELECT * FROM mca_calendar_event_links WHERE connection_id=?").all(c.id)
  for(const link of links) if(!visible.has(link.activity_id)) {
    const remote=await googleEvent(c,link.event_id)
    if(remote && remote.status!=="cancelled") await googleRequest(c,eventPath(c.calendar_id!,link.event_id)+"?sendUpdates=none",{method:"DELETE",headers:{"If-Match":remote.etag!}})
    await db.prepare("DELETE FROM mca_calendar_event_links WHERE connection_id=? AND activity_id=?").run(c.id,link.activity_id)
  }
  for(const row of visible.values()) {
    let link=links.find(l=>l.activity_id===row.id)
    if(!link) {
      if(row.status!=="scheduled") continue
      // Do not create historical events/reminders after a worker or company pause.
      if(Date.parse(row.ends_at)<=Date.now()) continue
      link={connection_id:c.id,activity_id:row.id,event_id:stableEventId(c.id,row.id),etag:null,local_version:0,baseline_json:null,conflict_json:null,resolution:null}
      await db.prepare("INSERT INTO mca_calendar_event_links (connection_id,activity_id,event_id) VALUES (?,?,?) ON CONFLICT DO NOTHING").run(c.id,row.id,link.event_id)
    }
    await reconcileActivity(c,actor,row,link)
  }
}
async function watch(c:Connection,source:Source) {
  if(source.channel_expires_at && Date.parse(source.channel_expires_at)>Date.now()+86400000) return
  const origin=process.env.MCA_APP_ORIGIN!
  if(!origin.startsWith("https://")) return // Local development uses polling.
  const token=createOpaqueToken(),id=newId()
  const result=await googleRequest<{id:string;resourceId:string;expiration:string}>(c,eventPath(source.calendar_id)+"/watch",{method:"POST",body:JSON.stringify({id,type:"web_hook",address:new URL("/api/mca/calendar/google/webhook",origin).href,token,params:{ttl:"604800"}})})
  await getDatabase().prepare("UPDATE mca_calendar_sources SET channel_id=?,channel_token_hash=?,resource_id=?,channel_expires_at=? WHERE connection_id=? AND calendar_id=?").run(result.id,hashOpaqueToken(token),result.resourceId,new Date(Number(result.expiration)).toISOString(),c.id,source.calendar_id)
  if(source.channel_id && source.resource_id) { try { await googleRequest(c,"/channels/stop",{method:"POST",body:JSON.stringify({id:source.channel_id,resourceId:source.resource_id})}) } catch { /* Old channels expire; polling remains available. */ } }
}
async function syncSource(c:Connection,source:Source,reset=false):Promise<void> {
  const db=getDatabase()
  let page:string|undefined,nextToken:string|undefined
  // A rolling materialized window expands recurring Google events without unbounded series.
  const params:Record<string,string>={maxResults:"2500",singleEvents:"true",showDeleted:"true"}
  if(source.sync_token && !reset) params.syncToken=source.sync_token
  else { params.timeMin=new Date(Date.now()-93*86400000).toISOString();params.timeMax=new Date(Date.now()+366*86400000).toISOString() }
  if(!params.syncToken) await db.prepare("DELETE FROM mca_calendar_external_events WHERE connection_id=? AND calendar_id=?").run(c.id,source.calendar_id)
  do {
    let result:{items?:GoogleEvent[];nextPageToken?:string;nextSyncToken?:string}
    try { result=await googleRequest(c,eventPath(source.calendar_id)+"?"+new URLSearchParams({...params,...(page?{pageToken:page}:{})})) }
    catch(error) { if(error instanceof GoogleCalendarError && error.status===410 && !reset) return syncSource(c,source,true);throw error }
    for(const raw of result.items??[]) {
      if(source.calendar_id===c.calendar_id && await db.prepare("SELECT activity_id FROM mca_calendar_event_links WHERE connection_id=? AND event_id=?").get(c.id,raw.id)) {
        await db.prepare("DELETE FROM mca_calendar_external_events WHERE connection_id=? AND calendar_id=? AND event_id=?").run(c.id,source.calendar_id,raw.id)
        continue
      }
      const fields=raw.status!=="cancelled"?remoteFields(raw):undefined
      if(!fields) { await db.prepare("DELETE FROM mca_calendar_external_events WHERE connection_id=? AND calendar_id=? AND event_id=?").run(c.id,source.calendar_id,raw.id);continue }
      const event:CalendarEvent={id:`google:${source.calendar_id}:${raw.id}`,kind:"google",title:fields.title,start:fields.start,end:fields.end,allDay:fields.allDay,timezone:fields.timezone,status:"scheduled",editable:false,href:raw.htmlLink?.startsWith("https://www.google.com/calendar/") || raw.htmlLink?.startsWith("https://calendar.google.com/") ? raw.htmlLink:undefined}
      await db.prepare("INSERT INTO mca_calendar_external_events (connection_id,calendar_id,event_id,event_cipher) VALUES (?,?,?,?) ON CONFLICT(connection_id,calendar_id,event_id) DO UPDATE SET event_cipher=excluded.event_cipher").run(c.id,source.calendar_id,raw.id,encryptSensitive(JSON.stringify(event),c.workspace_id))
    }
    page=result.nextPageToken;nextToken=result.nextSyncToken
  } while(page)
  if(!nextToken) throw new Error("Google Calendar did not return a synchronization token.")
  await db.prepare("UPDATE mca_calendar_sources SET sync_token=? WHERE connection_id=? AND calendar_id=?").run(nextToken,c.id,source.calendar_id)
}
export async function syncConnection(id:string):Promise<void> {
  if(!googleEnabled()) return
  let attemptedCredential:string|undefined
  try {
    // Serialize provider mutations, disconnects, and conflict decisions per connection.
    // PostgreSQL releases this transaction lock even if a worker crashes.
    await withTransaction(async db=>{
      const lock=await db.prepare<{locked:boolean}>("SELECT pg_try_advisory_xact_lock(hashtext(?)) locked").get(`calendar:${id}`)
      if(!lock?.locked) return
      const c=await db.prepare<Connection>("SELECT * FROM mca_calendar_connections WHERE id=? FOR UPDATE").get(id)
      if(!c || c.status==="reconnect") return
      if(!(await getCompanyAccess(c.workspace_id)).allowed) {
        await db.prepare("UPDATE mca_calendar_connections SET next_sync_at=? WHERE id=?").run(new Date(Date.now()+300000).toISOString(),id)
        return
      }
      attemptedCredential=c.credential_cipher
      const actor=await connectionActor(c)
      if(!actor) {
        await db.prepare("DELETE FROM mca_calendar_connections WHERE id=?").run(id)
        return
      }
      await listSources(c)
      await syncActivities(c,actor)
      const sources=await db.prepare<Source>("SELECT * FROM mca_calendar_sources WHERE connection_id=? AND selected=1").all(id)
      for(const source of sources) {
          // Once a day, refresh the rolling range so future recurring instances enter the cache.
          const reset=!c.last_sync_at || c.last_sync_at.slice(0,10)!==nowIso().slice(0,10)
          await syncSource(c,source,reset)
        await watch(c,source)
      }
      const conflicts=await db.prepare<{count:string}>("SELECT count(*) count FROM mca_calendar_event_links WHERE connection_id=? AND conflict_json IS NOT NULL").get(id)
      await db.prepare("UPDATE mca_calendar_connections SET status=?,last_sync_at=?,next_sync_at=?,error=NULL,failures=0 WHERE id=?").run(Number(conflicts?.count)?"conflict":"connected",nowIso(),new Date(Date.now()+300000).toISOString(),id)
    })
  } catch(error) {
    if(error instanceof AppError && error.code==="company_paused") return
    const reconnect=error instanceof GoogleCalendarError && [401,403].includes(error.status)
    await getDatabase().prepare(`UPDATE mca_calendar_connections SET status=?,error=?,failures=failures+1,next_sync_at=? WHERE id=? AND credential_cipher=?`).run(reconnect?"reconnect":"error",reconnect?"Google access expired or a calendar permission was removed. Reconnect to continue.":"Calendar synchronization failed. It will retry automatically; you can also retry now.",new Date(Date.now()+300000).toISOString(),id,attemptedCredential??null)
    console.error(JSON.stringify({event:"calendar_sync_failed",connectionId:id,code:error instanceof GoogleCalendarError?error.status:"internal"}))
  }
}
export async function runCalendarWorkerOnce():Promise<number> {
  if(!googleEnabled()) return 0
  const connections=await getDatabase().prepare<{id:string}>("SELECT id FROM mca_calendar_connections WHERE next_sync_at<=? AND status<>'reconnect' ORDER BY next_sync_at LIMIT 20").all(nowIso())
  for(const c of connections) await syncConnection(c.id)
  return connections.length
}
export async function resolveCalendarConflict(actor:DealActor,activityId:string,input:{choice:"local"|"google";version:number;etag:string}) {
  await withTransaction(async db=>{
    const c=await connectionFor(actor)
    if(!c) throw new AppError(404,"calendar_not_connected","Connect Google Calendar first.")
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`calendar:${c.id}`)
    await db.prepare("SELECT id FROM mca_calendar_connections WHERE id=? FOR UPDATE").get(c.id)
    const row=await db.prepare<ActivityRow>("SELECT * FROM mca_calendar_activities WHERE id=? AND workspace_id=? FOR UPDATE").get(activityId,actor.workspaceId)
    if(!row || row.assignee_id!==actor.membershipId || !canEditActivity(actor,row)) throw new AppError(404,"activity_not_found","Activity not found.")
    await getDealForDocument(actor,row.deal_id)
    if(row.version!==input.version) throw new AppError(409,"activity_conflict","The activity changed. Reload before resolving.")
    const link=await db.prepare<Link>("SELECT * FROM mca_calendar_event_links WHERE connection_id=? AND activity_id=?").get(c.id,activityId)
    if(!link?.conflict_json || JSON.parse(link.conflict_json).etag!==input.etag) throw new AppError(409,"calendar_conflict_changed","The conflict changed. Reload before resolving.")
    await db.prepare("UPDATE mca_calendar_event_links SET resolution=? WHERE connection_id=? AND activity_id=?").run(input.choice,c.id,activityId)
    await db.prepare("UPDATE mca_calendar_connections SET next_sync_at=? WHERE id=?").run(nowIso(),c.id)
    await recordAuditEvent({context:actor,action:"calendar.conflict_resolved",resourceType:"calendar_activity",resourceId:activityId,metadata:{choice:input.choice}})
  })
}
