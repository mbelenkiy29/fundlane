import type { BackgroundJobKind } from "./queue"
import { AppError } from "../errors"

// Only jobs that can run without the native document scanner/PDF host belong here.
export const RUNTIME_KINDS = [
  "export_create", "export", "auto_submit", "submission_delivery",
  "application_invitation_email", "application_invitation_reminder",
  "multipart_task", "import_commit", "import_update_commit",
  "drive_preview", "drive_apply", "email_intake", "intake_replay",
] as const satisfies readonly BackgroundJobKind[]

const known = new Set<string>(RUNTIME_KINDS)

export function runtimeKinds(env: Record<string, string | undefined> = process.env): readonly BackgroundJobKind[] {
  const configured = env.MCA_JOB_RUNTIME_KINDS
  const requested = configured === undefined || configured === ""
    ? ["export_create", "export", ...(env.MCA_AUTO_SUBMIT_ENABLED === "true" ? ["auto_submit"] : [])]
    : configured.split(",").map(kind => kind.trim())
  if (requested.some(kind => !known.has(kind))) throw new AppError(503, "job_runtime_kinds_invalid", "Invalid MCA_JOB_RUNTIME_KINDS: use only registered non-native job kinds.")
  return [...new Set(requested)].filter(kind => kind !== "auto_submit" || env.MCA_AUTO_SUBMIT_ENABLED === "true") as BackgroundJobKind[]
}
