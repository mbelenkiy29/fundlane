import "server-only"

import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { getCompleteness } from "./completeness"
import { listExistingPositions } from "./statements"

export const UNDERWRITING_SEND_GATE_REASONS = ["completeness_not_ready", "positions_unconfirmed"] as const

export type UnderwritingSendGateReason = (typeof UNDERWRITING_SEND_GATE_REASONS)[number]

export interface UnderwritingSendGate {
  ok: boolean
  completenessReady: boolean
  proposedPositionCount: number
  reasons: UnderwritingSendGateReason[]
}

export function underwritingSendGateMessage(code: UnderwritingSendGateReason): string {
  return code === "positions_unconfirmed"
    ? "Proposed positions must be confirmed or dismissed before sending."
    : "Document completeness is not ready."
}

export function underwritingSendGateError(gate: UnderwritingSendGate): AppError {
  const code = gate.reasons[0] ?? "completeness_not_ready"
  return new AppError(422, code, underwritingSendGateMessage(code), undefined, {
    reasons: gate.reasons,
    completenessReady: gate.completenessReady,
    proposedPositionCount: gate.proposedPositionCount,
  })
}

export async function evaluateUnderwritingSendGates(actor: DealActor, dealId: string): Promise<UnderwritingSendGate> {
  const [completeness, positions] = await Promise.all([
    getCompleteness(actor, dealId),
    listExistingPositions(actor, dealId),
  ])
  const completenessReady = Boolean(completeness?.ready)
  const proposedPositionCount = positions.filter((position) => position.status === "proposed").length
  const reasons: UnderwritingSendGateReason[] = []
  if (!completenessReady) reasons.push("completeness_not_ready")
  if (proposedPositionCount > 0) reasons.push("positions_unconfirmed")
  return {
    ok: reasons.length === 0,
    completenessReady,
    proposedPositionCount,
    reasons,
  }
}
