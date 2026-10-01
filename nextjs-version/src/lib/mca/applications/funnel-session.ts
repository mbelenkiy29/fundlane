import type { ApplicationSession, InvitationFileView } from "./contracts"
import type { FunnelStepId } from "./form-schema"
import type { DealWriteInput } from "../deals/schema"
import { isDocumentReady } from "../documents/contracts"

export async function saveThenSubmit(
  session: ApplicationSession,
  save: (step: FunnelStepId, answers: DealWriteInput) => Promise<ApplicationSession>,
  submit: () => Promise<ApplicationSession>,
): Promise<ApplicationSession> {
  await save("review", session.answers)
  return submit()
}

export function mergeUploadedSession(current: ApplicationSession, uploaded: ApplicationSession): ApplicationSession {
  return { ...uploaded, step: current.step, answers: current.answers }
}

export function applicationFileError(files: InvitationFileView[], months: number): string | undefined {
  if (files.some(file => !isDocumentReady(file.processingState))) {
    return "Some files are still being checked or could not be accepted. Refresh file status before submitting. If a file remains blocked, contact your representative."
  }
  if (files.filter(file => file.category === "statement" && isDocumentReady(file.processingState)).length < months) {
    return `Upload at least ${months} recent bank statements that pass file checks.`
  }
  return undefined
}
