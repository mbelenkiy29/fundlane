import "server-only"
import { getDatabase } from "../db"
import type { DealActor } from "../deals/schema"
import { listSenders } from "./service"

export interface MailboxReadiness {
  ready: boolean
  providers: { google: boolean; microsoft: boolean }
  consumer: { state: "disabled" | "missing" | "stale" | "healthy"; lastCompletedAt?: string }
  senders: {
    id: string
    provider: "google" | "microsoft"
    fromAddress: string
    state: "pending" | "verified" | "expired" | "revoked"
    connection: "connected" | "connect_required" | "reconnect_required" | "disconnected"
    canReconnect: boolean
  }[]
}

/** Configuration and local grant readiness, never proof of provider delivery. */
export async function getMailboxReadiness(actor: DealActor): Promise<MailboxReadiness> {
  const authorized = await listSenders(actor)
  const senders: MailboxReadiness["senders"] = authorized.senders
    .filter(s => s.purpose === "merchant" && (s.provider === "google" || s.provider === "microsoft"))
    .map(s => ({
      id: s.id, provider: s.provider as "google" | "microsoft", fromAddress: s.fromAddress,
      state: s.state, canReconnect: Boolean(s.canReconnect),
      connection: s.state === "revoked" ? "disconnected" : s.conversationReady ? "connected" : s.state === "pending" ? "connect_required" : "reconnect_required",
    }))
  let consumer: MailboxReadiness["consumer"] = { state: "disabled" }
  if (process.env.MCA_EMAIL_CONVERSATIONS_RUNTIME === "vercel_cron") {
    const row = await getDatabase().prepare<{ last_completed_at: string | null }>(
      "SELECT last_completed_at FROM mca_email_runtime_lease WHERE id=1"
    ).get()
    const completed = row?.last_completed_at
    const age = completed ? Date.now() - Date.parse(completed) : NaN
    consumer = !completed ? { state: "missing" } : {
      state: Number.isFinite(age) && age >= 0 && age <= 600_000 ? "healthy" : "stale",
      lastCompletedAt: completed,
    }
  }
  return {
    ready: consumer.state === "healthy" && senders.some(s => s.connection === "connected" && authorized.oauth[s.provider]),
    providers: authorized.oauth, consumer, senders,
  }
}
