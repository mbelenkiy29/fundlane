import "server-only"

import { AppError } from "../errors"
import type { DriveFileResult } from "./contracts"

const DRIVE_API = "https://www.googleapis.com/drive/v3"
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder"
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet"
const MAX_DRIVE_FILE_BYTES = 25 * 1024 * 1024
const MAX_DRIVE_FILES = 2_000

export interface DriveCredential { accessToken: string; refreshToken?: string; expiresAt?: string }
export interface DriveListedFile extends DriveFileResult { modifiedTime?: string }
export const DRIVE_READ_SCOPE="https://www.googleapis.com/auth/drive.readonly"

function oauthConfig():{clientId:string;clientSecret:string;redirectUri:string}{const clientId=process.env.MCA_GOOGLE_DRIVE_CLIENT_ID?.trim(),clientSecret=process.env.MCA_GOOGLE_DRIVE_CLIENT_SECRET?.trim(),origin=process.env.MCA_APP_ORIGIN?.trim();if(!clientId||!clientSecret||!origin)throw new AppError(503,"drive_oauth_not_configured","Google Drive OAuth needs MCA_GOOGLE_DRIVE_CLIENT_ID, MCA_GOOGLE_DRIVE_CLIENT_SECRET, and MCA_APP_ORIGIN.");return{clientId,clientSecret,redirectUri:process.env.MCA_GOOGLE_DRIVE_REDIRECT_URI?.trim()||`${origin.replace(/\/$/,"")}/api/mca/imports/drive/callback`}}

export function driveAuthorizationUrl(state:string):string{const config=oauthConfig(),url=new URL("https://accounts.google.com/o/oauth2/v2/auth");url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:"code",scope:DRIVE_READ_SCOPE,access_type:"offline",prompt:"consent",include_granted_scopes:"true",state}).toString();return url.toString()}

async function oauthPost(body:URLSearchParams):Promise<Record<string,unknown>>{const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15_000);try{const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",redirect:"error",signal:controller.signal,headers:{"content-type":"application/x-www-form-urlencoded"},body});const payload=await response.json() as Record<string,unknown>;if(!response.ok)throw new AppError(502,"drive_oauth_exchange_failed","Google did not accept the authorization grant. Start the connection again.");return payload}catch(error){if(error instanceof AppError)throw error;throw new AppError(503,"drive_oauth_timeout","Google Drive authorization timed out. Start the connection again.")}finally{clearTimeout(timeout)}}

export async function exchangeDriveAuthorizationCode(code:string):Promise<{credential:DriveCredential;scope:string}>{const config=oauthConfig();if(!code.trim())throw new AppError(422,"drive_oauth_code_missing","Google did not return an authorization code.");const payload=await oauthPost(new URLSearchParams({code,client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:config.redirectUri,grant_type:"authorization_code"}));const accessToken=String(payload.access_token??""),refreshToken=String(payload.refresh_token??""),scope=String(payload.scope??"");if(!accessToken||!refreshToken)throw new AppError(422,"drive_oauth_offline_access","Google did not return offline access. Revoke the prior grant and authorize again.");if(!scope.split(/\s+/).includes(DRIVE_READ_SCOPE))throw new AppError(403,"drive_scope","The returned grant does not include the approved Google Drive read-only scope.");const seconds=Number(payload.expires_in??3600);return{credential:{accessToken,refreshToken,expiresAt:new Date(Date.now()+Math.max(60,seconds)*1000).toISOString()},scope}}

export async function refreshDriveCredential(credential:DriveCredential):Promise<DriveCredential>{if(!credential.refreshToken)throw new AppError(401,"drive_reconnect_required","Google Drive offline access is missing. Reconnect the folder.");const config=oauthConfig(),payload=await oauthPost(new URLSearchParams({refresh_token:credential.refreshToken,client_id:config.clientId,client_secret:config.clientSecret,grant_type:"refresh_token"})),accessToken=String(payload.access_token??"");if(!accessToken)throw new AppError(401,"drive_reconnect_required","Google Drive access could not be renewed. Reconnect the folder.");return{accessToken,refreshToken:credential.refreshToken,expiresAt:new Date(Date.now()+Math.max(60,Number(payload.expires_in??3600))*1000).toISOString()}}

export function parseDriveFolderId(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new AppError(422, "drive_folder_url", "Enter a valid Google Drive folder URL.") }
  if (url.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(url.hostname)) throw new AppError(422, "drive_folder_url", "Enter a Google Drive folder URL on drive.google.com.")
  const queryId = url.searchParams.get("id")
  const match = url.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,})/) ?? (queryId && /^[A-Za-z0-9_-]{10,}$/.test(queryId) ? ["", queryId] : null)
  if (!match) throw new AppError(422, "drive_folder_url", "The folder ID could not be read from this Google Drive URL.")
  return match[1]
}

async function driveJson(path: string, credential: DriveCredential, init: RequestInit = {}, timeoutMs = 20_000): Promise<{status:number;ok:boolean;payload:Record<string,unknown>}> {
  if (!credential.accessToken) throw new AppError(503, "drive_not_connected", "Connect Google Drive before importing a folder.")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${DRIVE_API}${path}`, { ...init, redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${credential.accessToken}`, ...(init.headers ?? {}) } })
    if(!response.body)return{status:response.status,ok:response.ok,payload:{}}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0
    while(true){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>2*1024*1024){await reader.cancel();throw new AppError(502,"drive_api_response_too_large","Google Drive returned an unexpectedly large metadata response.")}chunks.push(chunk.value)}
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
    let payload:Record<string,unknown>={};if(total){try{payload=JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>}catch{throw new AppError(502,"drive_api_error","Google Drive returned invalid metadata.")}}
    return{status:response.status,ok:response.ok,payload}
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(503, "drive_unavailable", "Google Drive did not respond in time. Retry from the saved checkpoint.")
  } finally { clearTimeout(timeout) }
}

export async function verifyDriveFolder(folderId: string, credential: DriveCredential): Promise<{ id: string; name: string }> {
  const fields = encodeURIComponent("id,name,mimeType,trashed")
  const response = await driveJson(`/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=${fields}`, credential)
  if (response.status === 401) throw new AppError(401, "drive_credential_expired", "Google Drive authorization expired. Reconnect and retry.")
  if (response.status === 403 || response.status === 404) throw new AppError(403, "drive_folder_denied", "The connected account cannot access this folder. Grant the folder to the app and retry.")
  if (!response.ok) throw new AppError(502, "drive_api_error", "Google Drive could not verify the folder.")
  const payload = response.payload as unknown as { id: string; name: string; mimeType: string; trashed?: boolean }
  if (payload.trashed || payload.mimeType !== GOOGLE_FOLDER_MIME) throw new AppError(422, "drive_folder_invalid", "The URL must reference an available Google Drive folder.")
  return { id: payload.id, name: payload.name }
}

export async function listDriveFolder(
  folderId: string,
  credential: DriveCredential,
  input: { pageToken?: string; pageSize?: number } = {},
): Promise<{ files: DriveListedFile[]; nextPageToken: string | null }> {
  const params = new URLSearchParams({
    q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`, spaces: "drive", supportsAllDrives: "true",
    includeItemsFromAllDrives: "true", pageSize: String(Math.min(input.pageSize ?? 100, 1000)),
    fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,capabilities/canDownload)",
  })
  if (input.pageToken) params.set("pageToken", input.pageToken)
  const response = await driveJson(`/files?${params}`, credential)
  if (response.status === 401) throw new AppError(401, "drive_credential_expired", "Google Drive authorization expired. Reconnect and resume.")
  if (!response.ok) throw new AppError(response.status === 403 ? 403 : 502, response.status === 403 ? "drive_folder_denied" : "drive_api_error", response.status === 403 ? "The connected account cannot list this folder." : "Google Drive could not list the folder.")
  const payload = response.payload as unknown as { nextPageToken?: string; files?: Array<{ id: string; name: string; mimeType: string; size?: string; md5Checksum?: string; modifiedTime?: string; capabilities?: { canDownload?: boolean } }> }
  const files = (payload.files ?? []).slice(0, MAX_DRIVE_FILES).map((file): DriveListedFile => ({
    id: file.id, name: file.name, mimeType: file.mimeType, size: file.size ? Number(file.size) : null,
    md5Checksum: file.md5Checksum ?? null, canDownload: file.capabilities?.canDownload !== false, state: "listed", modifiedTime: file.modifiedTime,
  }))
  return { files, nextPageToken: payload.nextPageToken ?? null }
}

export async function downloadDriveFile(file: DriveListedFile, credential: DriveCredential): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }> {
  if (!file.canDownload) throw new AppError(403, "drive_file_denied", `${file.name} cannot be downloaded by the connected account.`)
  if (file.size !== null && file.size > MAX_DRIVE_FILE_BYTES) throw new AppError(422, "drive_file_too_large", `${file.name} exceeds the 25 MiB transfer limit.`)
  const isSheet = file.mimeType === GOOGLE_SHEET_MIME
  const path = isSheet
    ? `/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}`
    : `/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000)
  let bytes: Uint8Array
  try {
    const response = await fetch(`${DRIVE_API}${path}`, { redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${credential.accessToken}` } })
    if (response.status === 403) throw new AppError(403, "drive_file_denied", `${file.name} is no longer downloadable.`)
    if (response.status === 404) throw new AppError(404, "drive_file_removed", `${file.name} was removed after listing.`)
    if (!response.ok || !response.body) throw new AppError(502, "drive_download_failed", `${file.name} could not be downloaded. Retry from the saved checkpoint.`)
    const length = Number(response.headers.get("content-length") ?? 0)
    if (length > MAX_DRIVE_FILE_BYTES) throw new AppError(422, "drive_file_too_large", `${file.name} exceeds the 25 MiB transfer limit.`)
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0
    while (true) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.byteLength; if (total > MAX_DRIVE_FILE_BYTES) { await reader.cancel(); throw new AppError(422, "drive_file_too_large", `${file.name} exceeds the 25 MiB transfer limit.`) } chunks.push(chunk.value) }
    bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, "drive_download_timeout", `${file.name} did not finish downloading in time. Retry from the saved checkpoint.`) }
  finally { clearTimeout(timeout) }
  return { bytes, filename: isSheet && !file.name.toLocaleLowerCase().endsWith(".xlsx") ? `${file.name}.xlsx` : file.name, mimeType: isSheet ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : file.mimeType }
}

export async function revokeDriveCredential(credential: DriveCredential): Promise<void> {
  if (!credential.accessToken) return
  const body = new URLSearchParams({ token: credential.refreshToken ?? credential.accessToken })
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10_000)
  try { const response = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/x-www-form-urlencoded" }, body }); if (!response.ok && response.status !== 400) throw new AppError(502, "drive_revoke_failed", "Google Drive access could not be revoked. Retry before removing the connection.") }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, "drive_revoke_timeout", "Google Drive revocation timed out. Retry before removing the connection.") }
  finally { clearTimeout(timeout) }
}
