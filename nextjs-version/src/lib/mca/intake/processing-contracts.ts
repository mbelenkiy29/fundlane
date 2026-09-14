export type IntakeStageState = "waiting" | "running" | "complete" | "blocked" | "failed"
export interface IntakeStage { state: IntakeStageState; message?: string }
export interface IntakeProgress {
  state: "queued" | "running" | "needs_attention" | "ready_for_review" | "no_matches" | "failed" | "paused"
  stages: Record<"deal" | "documents" | "underwriting" | "matches", IntakeStage>
  message?: string
  matchedCount?: number
  analysisRunId?: string
}
export function initialIntakeProgress(): IntakeProgress {
  return { state: "queued", stages: {
    deal: { state: "complete" }, documents: { state: "waiting" },
    underwriting: { state: "waiting" }, matches: { state: "waiting" },
  } }
}
