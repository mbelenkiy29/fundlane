import "server-only"
import { createHash } from "node:crypto"
import { createOpaqueToken, decryptSensitive, encryptSensitive, hashOpaqueToken } from "../crypto"
import { getDatabase, newId, nowIso, recordAuditEvent, withTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { assertCompanyOperational } from "../company-access"
import type { GoogleConnectionView } from "./contracts"

const GOOGLE_API="https://www.googleapis.com/calendar/v3"
export const GOOGLE_CALENDAR_SCOPES=["openid","email","https://www.googleapis.com/auth/calendar.calendarlist.readonly","https://www.googleapis.com/auth/calendar.events.readonly","https://www.googleapis.com/auth/calendar.app.created"]
export const CALENDAR_CALLBACK="/api/mca/calendar/google/callback"
export interface Credential { accessToken:string; refreshToken:string; expiresAt:number }
export interface Connection { id:string; workspace_id:string; user_id:string; membership_id:string; email:string; credential_cipher:string; calendar_id:string|null; status:string; last_sync_at:string|null; next_sync_at:string; failures:number; error:string|null }
export interface GoogleEvent { id:string; etag?:string; status?:string; summary?:string; start?:{date?:string;dateTime?:string;timeZone?:string}; end?:{date?:string;dateTime?:string;timeZone?:string}; recurrence?:string[]; recurringEventId?:string; htmlLink?:string }
export class GoogleCalendarError extends Error {
  constructor(public status:number) { super(`Google Calendar request failed (${status}).`) }
}
let transport:typeof fetch=fetch
export function setCalendarFetchForTests(value?:typeof fetch) { transport=value??fetch }
export function googleEnabled() { return process.env.MCA_CALENDAR_GOOGLE_ENABLED==="true" }
export function googleConfigured() { return Boolean(process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET && process.env.MCA_APP_ORIGIN) }
function config() {
  if(!googleEnabled() || !googleConfigured()) throw new AppError(503,"google_calendar_unavailable","Google Calendar is not enabled. Ask your administrator to finish setup.")
  const origin=new URL(process.env.MCA_APP_ORIGIN!).origin
  if(!origin.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) throw new AppError(503,"calendar_origin_invalid","Calendar requires a secure application address.")
  return { clientId:process.env.GOOGLE_CALENDAR_CLIENT_ID!,clientSecret:process.env.GOOGLE_CALENDAR_CLIENT_SECRET!,redirectUri:origin+CALENDAR_CALLBACK,origin }
}
async function tokenRequest(values:Record<string,string>):Promise<Record<string,unknown>> {
  const c=config()
  const response=await transport("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...values,client_id:c.clientId,client_secret:c.clientSecret}),signal:AbortSignal.timeout(12000),redirect:"error"})
  if(!response.ok) throw new GoogleCalendarError(response.status===400?401:response.status)
  return response.json()
}
export async function googleRequest<T>(connection:Connection,path:string,init:RequestInit={}):Promise<T> {
  await assertCompanyOperational(connection.workspace_id)
  const credential=JSON.parse(decryptSensitive(connection.credential_cipher,connection.workspace_id)) as Credential
  if(credential.expiresAt<Date.now()+60000) {
    const refreshed=await tokenRequest({grant_type:"refresh_token",refresh_token:credential.refreshToken})
    if(typeof refreshed.access_token!=="string") throw new GoogleCalendarError(401)
    credential.accessToken=refreshed.access_token
    credential.expiresAt=Date.now()+Number(refreshed.expires_in??3600)*1000
    connection.credential_cipher=encryptSensitive(JSON.stringify(credential),connection.workspace_id)
    await getDatabase().prepare("UPDATE mca_calendar_connections SET credential_cipher=? WHERE id=?").run(connection.credential_cipher,connection.id)
  }
  await assertCompanyOperational(connection.workspace_id)
  const response=await transport(GOOGLE_API+path,{...init,headers:{"content-type":"application/json",...init.headers,authorization:`Bearer ${credential.accessToken}`},signal:AbortSignal.timeout(12000),redirect:"error"})
  if(!response.ok) throw new GoogleCalendarError(response.status)
  if(response.status===204) return undefined as T
  return response.json()
}
export function eventPath(calendarId:string,eventId?:string) { return `/calendars/${encodeURIComponent(calendarId)}/events${eventId?`/${encodeURIComponent(eventId)}`:""}` }
export async function connectionFor(actor:DealActor):Promise<Connection|undefined> {
  return getDatabase().prepare<Connection>("SELECT * FROM mca_calendar_connections WHERE workspace_id=? AND user_id=?").get(actor.workspaceId,actor.userId)
}
export async function beginGoogleAuthorization(actor:DealActor):Promise<string> {
  const c=config(),state=createOpaqueToken(),verifier=createOpaqueToken(48)
  await getDatabase().prepare("DELETE FROM mca_calendar_oauth_states WHERE expires_at<?").run(nowIso())
  await getDatabase().prepare("INSERT INTO mca_calendar_oauth_states (state_hash,workspace_id,user_id,membership_id,verifier_cipher,expires_at) VALUES (?,?,?,?,?,?)").run(hashOpaqueToken(state),actor.workspaceId,actor.userId,actor.membershipId,encryptSensitive(verifier,actor.workspaceId),new Date(Date.now()+600000).toISOString())
  const params=new URLSearchParams({client_id:c.clientId,redirect_uri:c.redirectUri,response_type:"code",scope:GOOGLE_CALENDAR_SCOPES.join(" "),state,access_type:"offline",prompt:"consent",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"})
  return "https://accounts.google.com/o/oauth2/v2/auth?"+params
}
export async function finishGoogleAuthorization(actor:DealActor,state:string,code:string):Promise<void> {
  const c=config()
  const saved=await getDatabase().prepare<{verifier_cipher:string}>("DELETE FROM mca_calendar_oauth_states WHERE state_hash=? AND workspace_id=? AND user_id=? AND membership_id=? AND expires_at>? RETURNING verifier_cipher").get(hashOpaqueToken(state),actor.workspaceId,actor.userId,actor.membershipId,nowIso())
  if(!saved) throw new AppError(400,"calendar_oauth_state","This connection request expired. Connect Google Calendar again.")
  const token=await tokenRequest({grant_type:"authorization_code",code,redirect_uri:c.redirectUri,code_verifier:decryptSensitive(saved.verifier_cipher,actor.workspaceId)})
  const granted=new Set(String(token.scope??"").split(" "))
  if(GOOGLE_CALENDAR_SCOPES.filter(s=>s.startsWith("https:")).some(scope=>!granted.has(scope))) throw new AppError(400,"calendar_oauth_scopes","Allow all requested calendar permissions, then reconnect.")
  if(typeof token.access_token!=="string" || typeof token.refresh_token!=="string") throw new AppError(400,"calendar_oauth_token","Google did not grant offline access. Connect again.")
  const response=await transport("https://www.googleapis.com/oauth2/v2/userinfo",{headers:{authorization:`Bearer ${token.access_token}`},redirect:"error",signal:AbortSignal.timeout(12000)})
  if(!response.ok) throw new GoogleCalendarError(response.status)
  const profile=await response.json() as {email?:string;verified_email?:boolean}
  if(!profile.email || !profile.verified_email) throw new AppError(400,"calendar_oauth_identity","Google did not return a verified email address.")
  const credential:Credential={accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt:Date.now()+Number(token.expires_in??3600)*1000}
  await withTransaction(async db=>{
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`calendar-owner:${actor.workspaceId}:${actor.userId}`)
    const old=await connectionFor(actor)
    if(old) await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`calendar:${old.id}`)
    if(old && old.email!==profile.email) throw new AppError(409,"calendar_account_changed","Disconnect your current Google account before connecting a different account.")
    await db.prepare(`INSERT INTO mca_calendar_connections (id,workspace_id,user_id,membership_id,email,credential_cipher,next_sync_at,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET credential_cipher=excluded.credential_cipher,membership_id=excluded.membership_id,status='pending',next_sync_at=excluded.next_sync_at,failures=0,error=NULL`).run(newId(),actor.workspaceId,actor.userId,actor.membershipId,profile.email,encryptSensitive(JSON.stringify(credential),actor.workspaceId),nowIso(),nowIso())
    await recordAuditEvent({context:actor,action:"calendar.google_connected",resourceType:"calendar_connection",resourceId:old?.id??actor.membershipId!})
  })
}
export async function googleConnectionView(actor:DealActor):Promise<GoogleConnectionView> {
  const connection=await connectionFor(actor)
  const calendars=connection?await getDatabase().prepare<{calendar_id:string;name:string;selected:number}>("SELECT calendar_id,name,selected FROM mca_calendar_sources WHERE connection_id=? AND calendar_id<>COALESCE(?, '') ORDER BY name").all(connection.id,connection.calendar_id):[]
  return {configured:googleConfigured(),enabled:googleEnabled(),connected:Boolean(connection),email:connection?.email,status:connection?.status,lastSync:connection?.last_sync_at??undefined,error:connection?.error??undefined,calendars:calendars.map(c=>({id:c.calendar_id,name:c.name,selected:Boolean(c.selected)}))}
}
export async function changeGoogleConnection(actor:DealActor,input:{action:string;calendarIds?:string[]}):Promise<void> {
  await withTransaction(async db=>{
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`calendar-owner:${actor.workspaceId}:${actor.userId}`)
    const c=await connectionFor(actor)
    if(!c) throw new AppError(404,"calendar_not_connected","Connect Google Calendar first.")
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`calendar:${c.id}`)
    if(input.action==="disconnect") {
      // Stop remote channels where possible; removing local channel tokens always disables delivery.
      const channels=await db.prepare<{channel_id:string;resource_id:string}>("SELECT channel_id,resource_id FROM mca_calendar_sources WHERE connection_id=? AND channel_id IS NOT NULL").all(c.id)
      for(const ch of channels) { try { await googleRequest(c,"/channels/stop",{method:"POST",body:JSON.stringify({id:ch.channel_id,resourceId:ch.resource_id})}) } catch { /* Expired access must not prevent local disconnection. */ } }
      await db.prepare("DELETE FROM mca_calendar_connections WHERE id=?").run(c.id)
      await db.prepare("DELETE FROM mca_calendar_oauth_states WHERE workspace_id=? AND user_id=?").run(actor.workspaceId,actor.userId)
      await recordAuditEvent({context:actor,action:"calendar.google_disconnected",resourceType:"calendar_connection",resourceId:c.id})
      return
    }
    if(input.action==="select") {
      const known=await db.prepare<{calendar_id:string}>("SELECT calendar_id FROM mca_calendar_sources WHERE connection_id=? AND calendar_id<>COALESCE(?,'')").all(c.id,c.calendar_id)
      const ids=input.calendarIds??[]
      if(ids.length>20 || ids.some(id=>!known.some(k=>k.calendar_id===id))) throw new AppError(422,"invalid_calendars","Choose up to 20 available calendars.")
      for(const source of known) {
        const selected=Number(ids.includes(source.calendar_id))
        await db.prepare("UPDATE mca_calendar_sources SET selected=? WHERE connection_id=? AND calendar_id=?").run(selected,c.id,source.calendar_id)
        if(!selected) {
          await db.prepare("DELETE FROM mca_calendar_external_events WHERE connection_id=? AND calendar_id=?").run(c.id,source.calendar_id)
          await db.prepare("UPDATE mca_calendar_sources SET sync_token=NULL WHERE connection_id=? AND calendar_id=?").run(c.id,source.calendar_id)
        }
      }
    }
    if(!["select","sync"].includes(input.action)) throw new AppError(422,"invalid_action","Unknown calendar action.")
    await db.prepare("UPDATE mca_calendar_connections SET next_sync_at=?,error=NULL,status=CASE WHEN status='reconnect' THEN 'reconnect' ELSE 'pending' END WHERE id=?").run(nowIso(),c.id)
  })
}
export async function receiveGoogleNotification(request:Request):Promise<void> {
  const channel=request.headers.get("x-goog-channel-id"),token=request.headers.get("x-goog-channel-token"),resource=request.headers.get("x-goog-resource-id")
  if(!channel || !token || !resource || token.length>200 || channel.length>100) throw new AppError(403,"invalid_calendar_notification","Invalid calendar notification.")
  const result=await getDatabase().prepare(`UPDATE mca_calendar_connections SET next_sync_at=? WHERE id IN (SELECT connection_id FROM mca_calendar_sources WHERE channel_id=? AND channel_token_hash=? AND resource_id=? AND channel_expires_at>?)`).run(nowIso(),channel,hashOpaqueToken(token),resource,nowIso())
  if(!result.changes) throw new AppError(403,"invalid_calendar_notification","Invalid calendar notification.")
}
