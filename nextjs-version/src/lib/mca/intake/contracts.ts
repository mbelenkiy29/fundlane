import type { DealStatus, DealWriteInput } from "../deals/schema"

export interface IntakeAnswer {
  key: string
  label: string
  value: string
}

export interface NormalizedIntakeInput {
  schemaVersion: 1
  provider: string
  eventId: string
  answers?: IntakeAnswer[]
  application: DealWriteInput
  sourceReference?: string
  initialStatus?: DealStatus
}

export interface IntakeResult {
  intakeId: string
  dealId: string | null
  created: boolean
  state: "received" | "validated" | "created" | "file_pending" | "error"
  warnings: string[]
}
