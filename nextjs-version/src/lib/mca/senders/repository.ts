import "server-only"

import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, type DbExecutor } from "../db"
import type { EmailSender, SenderProvider, SenderPurpose, SenderState } from "./contracts"

function db(): DbExecutor {
  return getDatabase()
}

export type SmtpCredential = {
  kind: "smtp"
  host: string
  port: number
  username: string
  password: string
  secure: boolean
}

export type SendGridCredential = {
  kind: "sendgrid"
  apiKey: string
}

export type OAuthCredential = {
  kind: "oauth"
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  scope?: string
  email?: string
}

export type StoredSenderCredential = SmtpCredential | SendGridCredential | OAuthCredential

export interface StoredEmailSender {
  id: string
  workspaceId: string
  provider: SenderProvider
  purpose: SenderPurpose
  fromName: string
  fromAddress: string
  signature?: string
  credentialCipher?: string
  state: SenderState
  isDefault: boolean
  verifiedAt?: string
  lastError?: string
  createdByUserId?: string
  createdAt: string
  updatedAt: string
  ownerMembershipId?: string
  memberIds: string[]
}

type SenderRow = {
  id: string
  workspace_id: string
  provider: string
  purpose: string
  from_name: string
  from_address: string
  signature: string | null
  credential_cipher: string | null
  state: string
  is_default: number | string
  verified_at: string | null
  last_error: string | null
  owner_membership_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

type MemberRow = { sender_id: string; membership_id: string }

function mapSender(row: SenderRow, memberIds: string[]): StoredEmailSender {
  return {
    ownerMembershipId: row.owner_membership_id ?? undefined,
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider as SenderProvider,
    purpose: row.purpose as SenderPurpose,
    fromName: row.from_name,
    fromAddress: row.from_address,
    signature: row.signature ?? undefined,
    credentialCipher: row.credential_cipher ?? undefined,
    state: row.state as SenderState,
    isDefault: Number(row.is_default) !== 0,
    verifiedAt: row.verified_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberIds,
  }
}

async function memberIdsFor(senderIds: string[], executor: DbExecutor = db()): Promise<Map<string, string[]>> {
  const members = new Map<string, string[]>()
  if (!senderIds.length) return members
  const placeholders = senderIds.map(() => "?").join(",")
  const rows = await executor.prepare<MemberRow>(
    `SELECT sender_id, membership_id FROM mca_email_sender_members WHERE sender_id IN (${placeholders}) ORDER BY created_at, membership_id`,
  ).all(...senderIds)
  for (const row of rows) {
    const list = members.get(row.sender_id) ?? []
    list.push(row.membership_id)
    members.set(row.sender_id, list)
  }
  return members
}

export function encryptSenderCredential(workspaceId: string, credential: StoredSenderCredential): string {
  return encryptSensitive(JSON.stringify(credential), workspaceId)
}

export function decryptSenderCredential(workspaceId: string, cipher: string): StoredSenderCredential | undefined {
  try {
    const parsed = JSON.parse(decryptSensitive(cipher, workspaceId)) as StoredSenderCredential
    if (!parsed || typeof parsed !== "object" || !parsed.kind) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function senderConversationReady(record: StoredEmailSender): boolean {
  const credential = record.credentialCipher ? decryptSenderCredential(record.workspaceId, record.credentialCipher) : undefined
  if (record.state !== "verified" || credential?.kind !== "oauth" || !credential.refreshToken || credential.email?.toLowerCase() !== record.fromAddress.toLowerCase()) return false
  const scopes = new Set((credential.scope ?? "").toLowerCase().split(/\s+/).map(s => s.replace("https://graph.microsoft.com/", "")))
  return record.provider === "google"
    ? scopes.has("https://www.googleapis.com/auth/gmail.readonly") && scopes.has("https://www.googleapis.com/auth/gmail.send")
    : record.provider === "microsoft" && scopes.has("mail.read") && scopes.has("mail.send")
}

export function toPublicSender(record: StoredEmailSender): EmailSender {
  return {
    ownerMembershipId: record.ownerMembershipId,
    conversationReady: senderConversationReady(record),
    id: record.id,
    workspaceId: record.workspaceId,
    provider: record.provider,
    purpose: record.purpose,
    fromName: record.fromName,
    fromAddress: record.fromAddress,
    signature: record.signature,
    state: record.state,
    isDefault: record.isDefault,
    verifiedAt: record.verifiedAt,
    lastError: record.lastError,
    hasCredential: Boolean(record.credentialCipher),
    memberIds: [...record.memberIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export async function findSenderById(workspaceId: string, id: string, executor: DbExecutor = db()): Promise<StoredEmailSender | undefined> {
  const row = await executor.prepare<SenderRow>("SELECT * FROM mca_email_senders WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  if (!row) return undefined
  const members = await memberIdsFor([id], executor)
  return mapSender(row, members.get(id) ?? [])
}

export async function listSendersByWorkspace(workspaceId: string, executor: DbExecutor = db()): Promise<StoredEmailSender[]> {
  const rows = await executor.prepare<SenderRow>(
    "SELECT * FROM mca_email_senders WHERE workspace_id = ? ORDER BY is_default DESC, purpose, from_name, id",
  ).all(workspaceId)
  const members = await memberIdsFor(rows.map((row) => row.id), executor)
  return rows.map((row) => mapSender(row, members.get(row.id) ?? []))
}

export async function insertSender(input: {
  id: string
  workspaceId: string
  provider: SenderProvider
  purpose: SenderPurpose
  fromName: string
  fromAddress: string
  signature?: string | null
  credentialCipher?: string | null
  state: SenderState
  isDefault: boolean
  verifiedAt?: string | null
  lastError?: string | null
  createdByUserId?: string | null
  createdAt: string
  updatedAt: string
  ownerMembershipId?: string | null
  memberIds: string[]
}, executor: DbExecutor = db()): Promise<StoredEmailSender> {
  await executor.prepare(`INSERT INTO mca_email_senders
    (id, workspace_id, provider, purpose, from_name, from_address, signature, credential_cipher, state, is_default, verified_at, last_error, created_by_user_id, created_at, updated_at, owner_membership_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id,
    input.workspaceId,
    input.provider,
    input.purpose,
    input.fromName,
    input.fromAddress,
    input.signature ?? null,
    input.credentialCipher ?? null,
    input.state,
    input.isDefault ? 1 : 0,
    input.verifiedAt ?? null,
    input.lastError ?? null,
    input.createdByUserId ?? null,
    input.createdAt,
    input.updatedAt,
    input.ownerMembershipId ?? null,
  )
  await replaceSenderMembers(input.workspaceId, input.id, input.memberIds, input.createdAt, executor)
  const saved = await findSenderById(input.workspaceId, input.id, executor)
  if (!saved) throw new Error("Email sender was not found after insert.")
  return saved
}

export async function updateSenderRecord(input: {
  id: string
  workspaceId: string
  fromName?: string
  fromAddress?: string
  signature?: string | null
  credentialCipher?: string | null
  state?: SenderState
  isDefault?: boolean
  verifiedAt?: string | null
  lastError?: string | null
  updatedAt: string
  memberIds?: string[]
}, executor: DbExecutor = db()): Promise<StoredEmailSender> {
  const current = await findSenderById(input.workspaceId, input.id, executor)
  if (!current) throw new Error("Email sender was not found after update.")
  const fromName = input.fromName ?? current.fromName
  const fromAddress = input.fromAddress ?? current.fromAddress
  const signature = input.signature === undefined ? current.signature ?? null : input.signature
  const credentialCipher = input.credentialCipher === undefined ? current.credentialCipher ?? null : input.credentialCipher
  const state = input.state ?? current.state
  const isDefault = input.isDefault ?? current.isDefault
  const verifiedAt = input.verifiedAt === undefined ? current.verifiedAt ?? null : input.verifiedAt
  const lastError = input.lastError === undefined ? current.lastError ?? null : input.lastError
  await executor.prepare(`UPDATE mca_email_senders SET
    from_name = ?, from_address = ?, signature = ?, credential_cipher = ?, state = ?, is_default = ?, verified_at = ?, last_error = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(
    fromName,
    fromAddress,
    signature,
    credentialCipher,
    state,
    isDefault ? 1 : 0,
    verifiedAt,
    lastError,
    input.updatedAt,
    input.workspaceId,
    input.id,
  )
  if (input.memberIds) await replaceSenderMembers(input.workspaceId, input.id, input.memberIds, input.updatedAt, executor)
  const saved = await findSenderById(input.workspaceId, input.id, executor)
  if (!saved) throw new Error("Email sender was not found after update.")
  return saved
}

export async function clearDefaultSenders(workspaceId: string, purpose: SenderPurpose, exceptId: string, updatedAt: string, executor: DbExecutor = db()): Promise<void> {
  await executor.prepare(
    "SELECT id FROM mca_email_senders WHERE workspace_id = ? AND purpose = ? FOR UPDATE",
  ).all(workspaceId, purpose)
  await executor.prepare(
    "UPDATE mca_email_senders SET is_default = 0, updated_at = ? WHERE workspace_id = ? AND purpose = ? AND is_default <> 0 AND id <> ?",
  ).run(updatedAt, workspaceId, purpose, exceptId)
}

export async function replaceSenderMembers(workspaceId: string, senderId: string, memberIds: string[], createdAt: string, executor: DbExecutor = db()): Promise<void> {
  await executor.prepare("DELETE FROM mca_email_sender_members WHERE sender_id = ? AND workspace_id = ?").run(senderId, workspaceId)
  const insert = executor.prepare(
    "INSERT INTO mca_email_sender_members (sender_id, membership_id, workspace_id, created_at) VALUES (?, ?, ?, ?)",
  )
  for (const membershipId of memberIds) {
    await insert.run(senderId, membershipId, workspaceId, createdAt)
  }
}

export async function activeMembershipIdsInWorkspace(workspaceId: string, membershipIds: string[], executor: DbExecutor = db()): Promise<string[]> {
  if (!membershipIds.length) return []
  const placeholders = membershipIds.map(() => "?").join(",")
  const rows = await executor.prepare<{ id: string }>(
    `SELECT id FROM memberships WHERE workspace_id = ? AND status = 'active' AND id IN (${placeholders})`,
  ).all(workspaceId, ...membershipIds)
  return rows.map((row) => row.id)
}

export async function saveOauthState(input: {
  stateHash: string
  userId?: string | null
  workspaceId: string
  senderId: string
  provider: SenderProvider
  purpose: SenderPurpose
  expiresAt: string
  createdAt: string
}, executor: DbExecutor = db()): Promise<void> {
  await executor.prepare(`INSERT INTO mca_email_oauth_states
    (state_hash, workspace_id, sender_id, provider, purpose, expires_at, created_at, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.stateHash,
    input.workspaceId,
    input.senderId,
    input.provider,
    input.purpose,
    input.expiresAt,
    input.createdAt,
    input.userId ?? null,
  )
}

export async function consumeOauthState(workspaceId: string, stateHash: string, now: string, executor: DbExecutor = db(), userId?: string | null): Promise<{
  senderId: string
  provider: SenderProvider
  purpose: SenderPurpose
} | undefined> {
  const row = await executor.prepare<{
    sender_id: string | null
    provider: string
    purpose: string
    expires_at: string
  }>("DELETE FROM mca_email_oauth_states WHERE state_hash = ? AND workspace_id = ? AND user_id = ? RETURNING sender_id, provider, purpose, expires_at").get(stateHash, workspaceId, userId ?? null)
  if (!row?.sender_id || row.expires_at <= now) return undefined
  return {
    senderId: row.sender_id,
    provider: row.provider as SenderProvider,
    purpose: row.purpose as SenderPurpose,
  }
}
