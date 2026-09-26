import "server-only"

import { encryptSensitive, hmacScopedToken } from "../mca/crypto"
import { getDatabase } from "../mca/db"
import { sendUsesendEmail } from "../mca/intake/usesend"
import type { DemoRequest } from "./demo-schema"

type Contact = Pick<DemoRequest, "name" | "email" | "brokerage" | "teamSize" | "message">

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
  const apiKey = process.env.MCA_USESEND_API_KEY?.trim()
  const from = process.env.MCA_USESEND_FROM?.trim()
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
  await sendUsesendEmail({
    apiKey, from, to,
    subject: "New Fundlane demo request",
    text: lines.join("\n"),
    html: `<pre>${escape(lines.join("\n"))}</pre>`,
    idempotencyKey: requestId,
  })
  return true
}
