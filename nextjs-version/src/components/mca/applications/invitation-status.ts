import type { ApplicationInvitation } from "@/lib/mca/applications/contracts"

export function invitationStatus(row: ApplicationInvitation): string {
  if (row.submittedAt) return "Completed"
  if (!row.active) return "Link inactive"
  if (row.deliveries[0]?.requiresReconciliation) return "Email needs reconciliation"
  if (row.deliveries[0]?.failedNotSent) return "Email not sent — resend"
  if (!row.openedAt && !row.sentAt) {
    if (row.deliveries[0]?.state === "queued") return "Email queued"
    if (row.deliveries[0]?.state === "running") return "Sending email"
    if (row.deliveries[0]?.state === "failed") return "Email needs attention"
  }
  if (row.startedAt) return "Started"
  if (row.openedAt) return "Opened"
  if (row.sentAt) return "Sent"
  if (row.copiedAt) return "Link copied"
  return "Ready to send"
}
