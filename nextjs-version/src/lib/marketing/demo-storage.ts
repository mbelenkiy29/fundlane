import "server-only"

import { decryptSensitive, encryptSensitive, hmacScopedToken } from "../mca/crypto"
import { getDatabase } from "../mca/db"
import { sendSystemEmail, systemEmailCredentials } from "../mca/system-email"
import type { DemoRequest } from "./demo-schema"

type Contact = Pick<DemoRequest, "name" | "email" | "brokerage" | "teamSize" | "message">
type StoredRow = { request_id: string; payload_cipher: string; created_at: Date; notified_at: Date | null; notification_error: string | null; notification_attempts: number; notification_tracking_enabled: boolean }
export type DemoSubmission = Omit<StoredRow, "payload_cipher"> & { contact: Contact; notification_status: "sent" | "failed" | "not configured" | "pending" | "unknown" }

export function demoVisibilityEnabled() {
  return process.env.MCA_DEMO_VISIBILITY_ENABLED === "true"
}

function unpack(row: StoredRow): DemoSubmission {
  const { payload_cipher, ...metadata } = row
  return {
    ...metadata,
    contact: JSON.parse(decryptSensitive(payload_cipher, `marketing-demo-submission:${row.request_id}`)) as Contact,
    notification_status: !row.notification_tracking_enabled ? "unknown" : row.notified_at ? "sent" : row.notification_error === "not_configured" ? "not configured" : row.notification_error ? "failed" : "pending",
  }
}

export async function listDemoSubmissions(limit = 100): Promise<DemoSubmission[]> {
  const rows = await getDatabase().query<StoredRow>(
    `SELECT request_id, payload_cipher, created_at,
       (to_jsonb(s)->>'notified_at')::timestamptz AS notified_at,
       to_jsonb(s)->>'notification_error' AS notification_error,
       COALESCE((to_jsonb(s)->>'notification_attempts')::integer, 0) AS notification_attempts,
       COALESCE((to_jsonb(s)->>'notification_tracking_enabled')::boolean, false) AS notification_tracking_enabled
     FROM marketing_demo_submissions s ORDER BY created_at DESC LIMIT ?`,
    [Math.min(Math.max(limit, 1), 100)]
  )
  return rows.rows.map(unpack)
}

export async function hasUnnotifiedDemoSubmissions(): Promise<boolean> {
  return Boolean(await getDatabase().queryOne(`SELECT request_id FROM marketing_demo_submissions s
    WHERE COALESCE((to_jsonb(s)->>'notification_tracking_enabled')::boolean, false) = false
       OR (to_jsonb(s)->>'notified_at') IS NULL LIMIT 1`))
}

export async function isDemoSubmissionTracked(requestId: string): Promise<boolean> {
  const row = await getDatabase().queryOne<{ tracked: boolean }>(`SELECT
    COALESCE((to_jsonb(s)->>'notification_tracking_enabled')::boolean, false) AS tracked
    FROM marketing_demo_submissions s WHERE request_id = ?`, [requestId])
  return row?.tracked ?? false
}

export async function isDemoStorageAvailable(): Promise<boolean> {
  try {
    await getDatabase().queryOne("SELECT request_id FROM marketing_demo_submissions LIMIT 0")
    return true
  } catch {
    return false
  }
}

export async function storeDemoSubmission(requestId: string, contact: Contact): Promise<boolean> {
  const payload = JSON.stringify(contact)
  const digest = hmacScopedToken("marketing-demo-submission", requestId, payload)
  const cipher = encryptSensitive(payload, `marketing-demo-submission:${requestId}`)
  const inserted = await getDatabase().queryOne<{ request_id: string }>(
    `INSERT INTO marketing_demo_submissions
      (request_id, payload_digest, payload_cipher)
     VALUES (?, ?, ?)
     ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
    [requestId, digest, cipher]
  )
  if (inserted) return true
  const existing = await getDatabase().queryOne<{ payload_digest: string }>(
    "SELECT payload_digest FROM marketing_demo_submissions WHERE request_id = ?",
    [requestId]
  )
  if (existing?.payload_digest !== digest) throw new Error("Demo request ID conflict")
  return false
}

export async function notifyDemoSubmission(requestId: string, contact: Contact): Promise<boolean> {
  const to = process.env.MCA_DEMO_NOTIFY_EMAIL?.trim()
  const credentials = systemEmailCredentials()
  const apiKey = credentials?.apiKey
  const from = credentials?.from
  if (!to || !apiKey || !from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return false
  const lines = [
    `Name: ${contact.name}`,
    `Email: ${contact.email}`,
    `Brokerage: ${contact.brokerage}`,
    `Team size: ${contact.teamSize}`,
    `Message: ${contact.message || "(none)"}`,
    `Request ID: ${requestId}`,
  ]
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!)
  await sendSystemEmail({
    apiKey, from, to,
    subject: "New Fundlane demo request",
    text: lines.join("\n"),
    html: `<pre>${escape(lines.join("\n"))}</pre>`,
    idempotencyKey: requestId,
  })
  return true
}

/** A database lease prevents concurrent workers from sending the same lead. The provider also receives the stable request ID. */
export async function deliverStoredDemoSubmission(requestId: string): Promise<boolean> {
  const row = await getDatabase().queryOne<StoredRow>(
    `UPDATE marketing_demo_submissions SET notification_lease_until = now() + interval '60 seconds',
      notification_attempts = notification_attempts + 1
     WHERE request_id = ? AND notification_tracking_enabled AND notified_at IS NULL
       AND (notification_lease_until IS NULL OR notification_lease_until < now())
     RETURNING request_id, payload_cipher, created_at, notified_at, notification_error, notification_attempts, notification_tracking_enabled`,
    [requestId]
  )
  if (!row) return false
  let error = "delivery_failed"
  try {
    if (await notifyDemoSubmission(requestId, unpack(row).contact)) {
      await getDatabase().execute("UPDATE marketing_demo_submissions SET notified_at = now(), notification_error = NULL, notification_lease_until = NULL WHERE request_id = ?", [requestId])
      return true
    }
    error = "not_configured"
  } catch {
    // Provider details and contact information must not enter logs or the status column.
  }
  await getDatabase().execute("UPDATE marketing_demo_submissions SET notification_error = ?, notification_lease_until = NULL WHERE request_id = ?", [error, requestId])
  console.warn(JSON.stringify({ event: "marketing_demo_notification_unsent", requestId, reason: error }))
  return false
}

export async function retryUnsentDemoSubmissions(limit = 10): Promise<number> {
  if (!demoVisibilityEnabled()) return 0
  const rows = await getDatabase().query<{ request_id: string }>(
    `SELECT request_id FROM marketing_demo_submissions WHERE notification_tracking_enabled AND notified_at IS NULL
       AND (notification_lease_until IS NULL OR notification_lease_until < now())
     ORDER BY created_at LIMIT ?`, [Math.min(Math.max(limit, 1), 10)]
  )
  let sent = 0
  for (const row of rows.rows) if (await deliverStoredDemoSubmission(row.request_id)) sent++
  return sent
}
