import type { AdapterStatusResult } from "../../contracts"

export const QUANTUM_LENDS_SLUG = "quantum-lends"

export const QUANTUM_LENDS_FIXTURE_KEYS = [
  "accepted",
  "timeout",
  "expired",
  "sent",
  "approved",
  "funded",
  "declined",
  "unknown",
] as const
export type QuantumLendsFixtureKey = (typeof QUANTUM_LENDS_FIXTURE_KEYS)[number]

export const QUANTUM_LENDS_RAW_STATUS = {
  sent: "Sent",
  approved: "Approved",
  funded: "Funded",
  declined: "Declined",
  unknown: "OnHold",
} as const

const STATUS_NORMALIZED = {
  sent: "submitted",
  approved: "approved",
  funded: "funded",
  declined: "declined",
  unknown: "unknown",
} as const satisfies Record<keyof typeof QUANTUM_LENDS_RAW_STATUS, AdapterStatusResult["normalized"]>

const FIXTURE_SET = new Set<string>(QUANTUM_LENDS_FIXTURE_KEYS)

export function isQuantumLendsFixtureKey(value: string | undefined): value is QuantumLendsFixtureKey {
  return Boolean(value && FIXTURE_SET.has(value))
}

export function resolveQuantumLendsFixtureKey(destination: string, override?: string): QuantumLendsFixtureKey {
  if (isQuantumLendsFixtureKey(override)) return override
  const raw = destination.trim().toLowerCase()
  if (isQuantumLendsFixtureKey(raw)) return raw
  if (raw === QUANTUM_LENDS_SLUG) return "accepted"
  const separator = raw.startsWith(`${QUANTUM_LENDS_SLUG}:`) ? ":"
    : raw.startsWith(`${QUANTUM_LENDS_SLUG}/`) ? "/"
      : raw.startsWith(`${QUANTUM_LENDS_SLUG}#`) ? "#"
        : undefined
  if (separator) {
    const suffix = raw.slice(QUANTUM_LENDS_SLUG.length + 1)
    if (isQuantumLendsFixtureKey(suffix)) return suffix
  }
  return "accepted"
}

export function quantumLendsStatusFixture(key: QuantumLendsFixtureKey): {
  rawStatus: string
  normalized: AdapterStatusResult["normalized"]
  unknown: boolean
} {
  const statusKey = key === "accepted" || key === "timeout" || key === "expired" ? "sent" : key
  return {
    rawStatus: QUANTUM_LENDS_RAW_STATUS[statusKey],
    normalized: STATUS_NORMALIZED[statusKey],
    unknown: statusKey === "unknown",
  }
}

export const QUANTUM_LENDS_FIXTURES = {
  accepted: {
    ok: true,
    rawStatus: QUANTUM_LENDS_RAW_STATUS.sent,
    errorCode: undefined,
    errorMessage: undefined,
  },
  timeout: {
    ok: false,
    rawStatus: undefined,
    errorCode: "timeout",
    errorMessage: "The Quantum Lends API timed out before a deal was created. Retry with the same attempt key.",
  },
  expired: {
    ok: false,
    rawStatus: undefined,
    errorCode: "expired_credentials",
    errorMessage: "The Quantum Lends API credentials have expired. Update the API key for this environment.",
  },
} as const
