import { z } from "zod"

export const emailSendSchema = z
  .object({
    dealId: z.string().min(1),
    senderId: z.string().min(1),
    recipient: z.string().email().max(320),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n]/.test(value), "Use a single-line subject."),
    body: z.string().trim().min(1).max(20000),
    idempotencyKey: z.string().min(1).max(160),
  })
  .strict()
export const emailReplySchema = z
  .object({
    body: z.string().trim().min(1).max(20000),
    idempotencyKey: z.string().min(1).max(160),
  })
  .strict()
export type EmailSendInput = z.infer<typeof emailSendSchema>
export type EmailState =
  | "queued"
  | "sending"
  | "accepted"
  | "sent"
  | "received"
  | "failed"
  | "unknown"
  | "blocked"
export interface ConversationSummary {
  id: string
  dealId: string
  senderId: string
  senderAddress: string
  recipient: string
  subject: string
  updatedAt: string
  unread: number
  lastSyncedAt: string | null
  syncError: string | null
}
export interface ConversationMessage {
  id: string
  sequence: string
  direction: "inbound" | "outbound"
  body: string
  author: string
  state: EmailState
  error: string | null
  createdAt: string
}
export interface ConversationPage {
  conversations: ConversationSummary[]
  nextCursor: string | null
}
export interface MessagePage {
  conversation: ConversationSummary
  messages: ConversationMessage[]
  nextCursor: string | null
}
