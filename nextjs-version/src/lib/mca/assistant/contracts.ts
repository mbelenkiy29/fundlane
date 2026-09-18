import { z } from "zod"
import type {
  ExperienceView,
  Activity,
  AssistantFile
} from "./experience-contracts"

export const idSchema = z.string().uuid()
export const assistantCommand = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("message"),
      conversationId: idSchema,
      message: z.string().trim().min(1).max(8000),
      requestId: idSchema,
      attachmentIds: z.array(idSchema).max(5).optional()
    })
    .strict(),
  z
    .object({
      action: z.literal("decision"),
      conversationId: idSchema,
      approvalId: idSchema,
      approve: z.boolean()
    })
    .strict(),
  z
    .object({
      action: z.literal("answer"),
      conversationId: idSchema,
      questionId: idSchema,
      requestId: idSchema,
      answers: z.record(z.string().max(41), z.string().min(1).max(4000))
    })
    .strict(),
  z.object({ action: z.literal("cancel"), conversationId: idSchema }).strict()
])
export type AssistantCommand = z.infer<typeof assistantCommand>
export type RunStatus =
  | "running"
  | "awaiting_input"
  | "awaiting_approval"
  | "completed"
  | "cancelled"
  | "failed"
export type ActionKind = "sms" | "reminder" | "submissions" | "calendar_plan"
export interface ApprovalPreview {
  title: string
  details: Array<{ label: string; value: string }>
  blocked?: string
}
export interface ApprovalView {
  id: string
  status: string
  preview: ApprovalPreview
  result?: unknown
}
export interface ConversationView {
  id: string
  dealId: string | null
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>
  run: { id: string; status: RunStatus; error: string | null } | null
  approvals: ApprovalView[]
  experience?: ExperienceView
  olderCursor?: number | null
}
export type AssistantEvent =
  | { type: "activity"; activity: Activity; runId: string; sequence: number }
  | { type: "file"; file: AssistantFile; runId: string; sequence: number }
  | { type: "delta"; text: string }
  | { type: "progress"; text: string }
  | { type: "state"; state: ConversationView }
  | { type: "error"; text: string }

export function deliveryLabel(result: unknown): string {
  if (!result || typeof result !== "object")
    return "Review delivery status in the deal."
  const calendar = result as { created?: number; calendarUrl?: string }
  if (typeof calendar.created === "number" && calendar.calendarUrl) {
    return calendar.created
      ? `Scheduled ${calendar.created} calendar follow-up${calendar.created === 1 ? "" : "s"}.`
      : "No new calendar follow-ups were added."
  }
  const value = result as {
    delivery?: string
    state?: string
    jobs?: Array<{ state: string }>
  }
  if (value.jobs)
    return `Submission results: ${value.jobs.map((j) => j.state.replaceAll("_", " ")).join(", ")}.`
  if (value.delivery === "preview")
    return "Preview only — no external message was sent."
  const state = value.delivery ?? value.state
  if (state === "accepted")
    return "Accepted by the provider; delivery is not yet confirmed."
  if (state === "unknown")
    return "Delivery outcome unknown. Review the delivery record before retrying."
  if (state === "sent") return "Sent."
  if (state === "failed") return "Delivery failed. Review the delivery record."
  return "Review delivery status in the deal."
}

/** Sort keys for stable previews without removing any recipient, document, or content changes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
