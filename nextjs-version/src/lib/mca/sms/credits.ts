import "server-only"
import { assertTransactionExecutor, getDatabase, newId, nowIso, type DbExecutor } from "../db"
import { AppError } from "../errors"
import type { SmsCreditBalance } from "../platform-contracts"

type Account = { balance_segments: number; reserved_segments: number; updated_at: string }
type Reservation = { id: string; workspace_id: string; message_id: string; segments: number; payload_hash: string; state: "reserved" | "settled" | "released"; charge_segments: number | null }
type Entry = { workspace_id: string; reservation_id: string | null; purchase_id: string | null; provider_payment_id: string | null; event_key: string | null; kind: string; segments: number }
const MAX_SEGMENTS = 2147483647
const mutationTails = new WeakMap<DbExecutor, Promise<void>>()
/** Row locks exclude other transactions, not Promise.all work on this same executor. */
async function serializeMutation<T>(db: DbExecutor, operation: () => Promise<T>): Promise<T> {
  assertTransactionExecutor(db)
  const result = (mutationTails.get(db) ?? Promise.resolve()).then(() => {
    assertTransactionExecutor(db)
    return operation()
  })
  mutationTails.set(db, result.then(() => undefined, () => undefined))
  return result
}
const conflict = () => new AppError(409, "sms_credit_identity_conflict", "The credit reference has different immutable details.")
function quantity(value: number, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum || value > MAX_SEGMENTS)
    throw new AppError(400, "sms_credit_quantity_invalid", "Segment quantity is outside the supported integer range.")
}
function reference(...values: string[]) {
  if (values.some(value => typeof value !== "string" || !value.trim() || value.length > 256))
    throw new AppError(400, "sms_credit_reference_invalid", "Credit references must be nonempty and bounded.")
}
const balance = (row: Account): SmsCreditBalance => ({ balanceSegments: row.balance_segments, reservedSegments: row.reserved_segments, availableSegments: row.balance_segments - row.reserved_segments, updatedAt: row.updated_at })

/** Read-only; a company with no purchased credits has zero balances. */
export async function getSmsCreditBalance(workspaceId: string, db: DbExecutor = getDatabase()): Promise<SmsCreditBalance> {
  reference(workspaceId)
  const row = await db.queryOne<Account>(`SELECT COALESCE(a.balance_segments,0) balance_segments, COALESCE(a.reserved_segments,0) reserved_segments,
    COALESCE(a.updated_at,w.created_at) updated_at FROM workspaces w LEFT JOIN sms_credit_accounts a ON a.workspace_id=w.id WHERE w.id=?`, [workspaceId])
  if (!row) throw new AppError(404, "sms_credit_workspace_not_found", "The company does not exist.")
  return balance(row)
}
async function lockAccount(db: DbExecutor, workspaceId: string) {
  await db.execute("INSERT INTO sms_credit_accounts(workspace_id,updated_at) VALUES (?,?) ON CONFLICT DO NOTHING", [workspaceId, nowIso()])
  return (await db.queryOne<Account>("SELECT * FROM sms_credit_accounts WHERE workspace_id=? FOR UPDATE", [workspaceId]))!
}
async function append(db: DbExecutor, entry: Entry, balanceDelta: number, reservedDelta: number) {
  return db.queryOne<{ id: string }>(`INSERT INTO sms_credit_ledger(id,workspace_id,reservation_id,purchase_id,provider_payment_id,event_key,kind,segments,balance_delta,reserved_delta,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`, [newId(), entry.workspace_id, entry.reservation_id, entry.purchase_id, entry.provider_payment_id, entry.event_key, entry.kind, entry.segments, balanceDelta, reservedDelta, nowIso()])
}
async function updateAccount(db: DbExecutor, workspaceId: string, balanceDelta: number, reservedDelta: number) {
  await db.execute("UPDATE sms_credit_accounts SET balance_segments=balance_segments+?,reserved_segments=reserved_segments+?,updated_at=? WHERE workspace_id=?", [balanceDelta, reservedDelta, nowIso(), workspaceId])
  return getSmsCreditBalance(workspaceId, db)
}

/** Trusted services only. The caller owns withTransaction; no checkout or grant endpoint is enabled. */
export async function grantSmsCredits(db: DbExecutor, input: { workspaceId: string; purchaseId: string; providerPaymentId: string; segments: number }): Promise<SmsCreditBalance> {
  return serializeMutation(db, async () => {
    reference(input.workspaceId, input.purchaseId, input.providerPaymentId); quantity(input.segments)
    const account = await lockAccount(db, input.workspaceId)
    const existing = await db.queryOne<Entry>("SELECT * FROM sms_credit_ledger WHERE purchase_id=? OR provider_payment_id=?", [input.purchaseId, input.providerPaymentId])
    const matches = (row: Entry | undefined) => row?.workspace_id === input.workspaceId && row.purchase_id === input.purchaseId && row.provider_payment_id === input.providerPaymentId && row.segments === input.segments
    if (existing) {
      if (!matches(existing)) throw conflict()
      return balance(account)
    }
    if (account.balance_segments > MAX_SEGMENTS - input.segments) throw new AppError(409, "sms_credit_overflow", "The company credit balance would exceed its integer range.")
    const added = await append(db, { workspace_id: input.workspaceId, reservation_id: null, purchase_id: input.purchaseId, provider_payment_id: input.providerPaymentId, event_key: null, kind: "grant", segments: input.segments }, input.segments, 0)
    if (!added) {
      if (!matches(await db.queryOne<Entry>("SELECT * FROM sms_credit_ledger WHERE purchase_id=? OR provider_payment_id=?", [input.purchaseId, input.providerPaymentId]))) throw conflict()
      return balance(account)
    }
    return updateAccount(db, input.workspaceId, input.segments, 0)
  })
}

export async function reserveSmsCredits(db: DbExecutor, input: { workspaceId: string; messageId: string; segments: number; payloadHash: string }): Promise<{ reservationId: string; state: Reservation["state"] }> {
  return serializeMutation(db, async () => {
    reference(input.workspaceId, input.messageId, input.payloadHash); quantity(input.segments)
    const account = await lockAccount(db, input.workspaceId)
    const message = await db.queryOne<{ payload_hash: string }>("SELECT payload_hash FROM mca_sms_messages WHERE workspace_id=? AND id=? FOR SHARE", [input.workspaceId, input.messageId])
    if (!message) throw new AppError(404, "sms_credit_message_not_found", "The company message does not exist.")
    const existing = await db.queryOne<Reservation>("SELECT * FROM sms_credit_reservations WHERE workspace_id=? AND message_id=?", [input.workspaceId, input.messageId])
    if (existing) {
      if (existing.payload_hash !== input.payloadHash || existing.segments !== input.segments) throw conflict()
      return { reservationId: existing.id, state: existing.state }
    }
    if (message.payload_hash !== input.payloadHash) throw conflict()
    if (account.balance_segments - account.reserved_segments < input.segments) throw new AppError(402, "sms_credits_exhausted", "There are insufficient available SMS segments.")
    const id = newId()
    await db.execute("INSERT INTO sms_credit_reservations(id,workspace_id,message_id,segments,payload_hash,state,created_at) VALUES (?,?,?,?,?,'reserved',?)", [id, input.workspaceId, input.messageId, input.segments, input.payloadHash, nowIso()])
    await append(db, { workspace_id: input.workspaceId, reservation_id: id, purchase_id: null, provider_payment_id: null, event_key: null, kind: "reserve", segments: input.segments }, 0, input.segments)
    await updateAccount(db, input.workspaceId, 0, input.segments)
    return { reservationId: id, state: "reserved" }
  })
}

async function finish(db: DbExecutor, input: { workspaceId: string; messageId: string; eventKey: string }, kind: "settle" | "release", segments: number) {
  return serializeMutation(db, async () => {
    reference(input.workspaceId, input.messageId, input.eventKey); quantity(segments, 0)
    const account = await lockAccount(db, input.workspaceId)
    const reservation = await db.queryOne<Reservation>("SELECT * FROM sms_credit_reservations WHERE workspace_id=? AND message_id=?", [input.workspaceId, input.messageId])
    if (!reservation) throw new AppError(404, "sms_credit_reservation_not_found", "The company reservation does not exist.")
    const existing = await db.queryOne<Entry>("SELECT * FROM sms_credit_ledger WHERE event_key=?", [input.eventKey])
    const matches = (row: Entry | undefined) => row?.workspace_id === input.workspaceId && row.reservation_id === reservation.id && row.kind === kind && row.segments === segments
    if (existing) {
      if (!matches(existing)) throw conflict()
      return balance(account)
    }
    if (segments > reservation.segments) throw new AppError(400, "sms_credit_quantity_invalid", "Settlement cannot exceed the reserved quantity.")
    const state = kind === "settle" ? "settled" : "released"
    if (reservation.state !== "reserved" && reservation.state !== state) throw new AppError(409, "sms_credit_state_conflict", "The reservation already has a different terminal state.")
    if (reservation.state === "settled" && reservation.charge_segments !== segments) throw conflict()
    const pending = reservation.state === "reserved"
    const added = await append(db, { workspace_id: input.workspaceId, reservation_id: reservation.id, purchase_id: null, provider_payment_id: null, event_key: input.eventKey, kind, segments }, pending ? -segments : 0, pending ? -reservation.segments : 0)
    if (!added) {
      if (!matches(await db.queryOne<Entry>("SELECT * FROM sms_credit_ledger WHERE event_key=?", [input.eventKey]))) throw conflict()
      return balance(account)
    }
    // Distinct replays retain their immutable event identity but never move balances again.
    if (!pending) return balance(account)
    await db.execute("UPDATE sms_credit_reservations SET state=?,charge_segments=? WHERE id=? AND workspace_id=?", [state, kind === "settle" ? segments : null, reservation.id, input.workspaceId])
    return updateAccount(db, input.workspaceId, -segments, -reservation.segments)
  })
}

/** chargeSegments is resolved by a trusted service's approved policy, never a client. */
export function settleSmsCredits(db: DbExecutor, input: { workspaceId: string; messageId: string; eventKey: string; chargeSegments: number }): Promise<SmsCreditBalance> {
  return finish(db, input, "settle", input.chargeSegments)
}
export function releaseSmsCredits(db: DbExecutor, input: { workspaceId: string; messageId: string; eventKey: string }): Promise<SmsCreditBalance> {
  return finish(db, input, "release", 0)
}
