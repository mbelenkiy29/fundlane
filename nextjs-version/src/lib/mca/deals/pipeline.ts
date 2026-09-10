import type { DealStatus } from "./schema"

export const PIPELINE_VERSION = 1 as const

const allowed: Record<DealStatus, readonly DealStatus[]> = {
  lead: ["new_application", "closed"],
  new_application: ["missing_documents", "ready_to_submit", "closed"],
  missing_documents: ["new_application", "ready_to_submit", "closed"],
  ready_to_submit: ["submitted", "missing_documents", "closed"],
  submitted: ["offer", "resubmitting", "closed"],
  resubmitting: ["submitted", "offer", "closed"],
  offer: ["repricing", "contract", "resubmitting", "closed"],
  repricing: ["offer", "contract", "closed"],
  contract: ["funded", "offer", "closed"],
  funded: ["renewed", "missed_payments", "default", "closed"],
  renewed: ["funded", "missed_payments", "default", "closed"],
  missed_payments: ["funded", "renewed", "default", "closed"],
  default: ["missed_payments", "funded", "closed"],
  closed: ["lead", "new_application", "missing_documents", "ready_to_submit", "submitted", "offer", "contract", "funded"],
}

export function allowedTransitions(status: DealStatus): readonly DealStatus[] {
  return allowed[status]
}

export function canTransition(from: DealStatus, to: DealStatus): boolean {
  return from === to || allowed[from].includes(to)
}

export function transitionGuidance(from: DealStatus, to: DealStatus): string {
  const valid = allowedTransitions(from).join(", ")
  return `Cannot move from ${from} to ${to}. Allowed next statuses: ${valid || "none"}.`
}
