import { z } from "zod"
export const questionsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
        question: z.string().min(1).max(600),
        options: z.array(z.string().min(1).max(200)).max(5)
      })
      .strict()
  )
  .min(1)
  .max(3)
export type Question = z.infer<typeof questionsSchema>[number]
export interface QuestionView {
  id: string
  questions: Question[]
  status: string
}
export interface Citation {
  title: string
  url: string
}
export interface Activity {
  id: string
  runId: string
  sequence: number
  label: string
  status: "running" | "completed" | "failed" | "cancelled"
  kind: "tool" | "research" | "file" | "reasoning"
  text?: string
  startedAt: string
  completedAt?: string
}
export interface AssistantFile {
  id: string
  name: string
  mime: string
  bytes: number
  expiresAt: string
  state: "ready" | "expired" | "deleted" | "processing" | "failed"
  parentId?: string | null
  runId?: string | null
}
export interface MessageParts {
  runId?: string
  files?: AssistantFile[]
  citations?: Citation[]
  eventCursor?: number
}
export interface MemoryView {
  id: string
  category: string
  text: string
  updatedAt: string
}
export const memoryCategories = [
  "writing_style",
  "format",
  "terminology",
  "workflow"
] as const
export const memoryInput = z
  .object({
    category: z.enum(memoryCategories),
    text: z.string().trim().min(1).max(500)
  })
  .strict()
export interface ExperienceView {
  title: string
  activities: Activity[]
  question: QuestionView | null
  files: AssistantFile[]
  parts: Record<string, MessageParts>
  partial?: string
}
export const experienceEnabled = () =>
  process.env.MCA_ASSISTANT_EXPERIENCE_ENABLED === "true"
export const webEnabled = () =>
  experienceEnabled() && process.env.MCA_ASSISTANT_WEB_ENABLED === "true"
export const filesEnabled = () =>
  experienceEnabled() && process.env.MCA_ASSISTANT_FILES_ENABLED === "true"
export const ACTIVE_BUDGET_MS = 300_000
export const FILE_RETENTION_MS = 90 * 86400_000
