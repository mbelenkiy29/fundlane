export interface DecimalRatio {
  numerator: bigint
  denominator: bigint
  canonical: string
}

export interface BasisPointAllocation {
  recipientMembershipId: string
  percentageBasisPoints: number
}

export interface AllocatedAmount extends BasisPointAllocation {
  amountCents: number
}

const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/

export function assertCents(value: number, field = "amountCents"): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer of cents.`)
  return value
}

export function parseDecimal(value: string, options: { field?: string; maxScale?: number; allowZero?: boolean } = {}): DecimalRatio {
  const field = options.field ?? "decimal"
  const normalized = value.trim()
  const match = DECIMAL.exec(normalized)
  if (!match) throw new TypeError(`${field} must be an unsigned base-10 decimal string.`)
  const integer = match[1]
  const fraction = match[2] ?? ""
  const maxScale = options.maxScale ?? 6
  if (fraction.length > maxScale) throw new TypeError(`${field} supports at most ${maxScale} decimal places.`)
  const denominator = BigInt(10) ** BigInt(fraction.length)
  const numerator = BigInt(`${integer}${fraction}`)
  if (numerator === BigInt(0) && options.allowZero === false) throw new TypeError(`${field} must be greater than zero.`)
  return { numerator, denominator, canonical: fraction ? `${BigInt(integer)}.${fraction}` : BigInt(integer).toString() }
}

/** Integer division rounded half away from zero. */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) throw new TypeError("denominator must be positive")
  const sign = numerator < BigInt(0) ? BigInt(-1) : BigInt(1)
  const absolute = numerator < BigInt(0) ? -numerator : numerator
  const quotient = absolute / denominator
  const remainder = absolute % denominator
  return sign * (quotient + (remainder * BigInt(2) >= denominator ? BigInt(1) : BigInt(0)))
}

function safeNumber(value: bigint, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${field} exceeds the supported integer-cent range.`)
  return parsed
}

export function multiplyCentsByDecimal(cents: number, decimal: string, field = "decimal"): number {
  assertCents(cents)
  const ratio = parseDecimal(decimal, { field, allowZero: true })
  return safeNumber(divideRounded(BigInt(cents) * ratio.numerator, ratio.denominator), "calculated amount")
}

export function percentageOfCents(cents: number, basisPoints: number): number {
  assertCents(cents)
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new TypeError("percentageBasisPoints must be an integer from 0 through 10000.")
  }
  return safeNumber(divideRounded(BigInt(cents) * BigInt(basisPoints), BigInt(10_000)), "calculated amount")
}

/**
 * Allocates every cent. Largest fractional remainders win; ties retain input
 * order. That policy is deterministic and is persisted in each split snapshot.
 */
export function allocateCents(baseCents: number, allocations: readonly BasisPointAllocation[]): AllocatedAmount[] {
  assertCents(baseCents, "baseCents")
  if (!allocations.length) throw new TypeError("At least one allocation is required.")
  const recipients = new Set<string>()
  let totalBasisPoints = 0
  const parts = allocations.map((allocation, index) => {
    if (!allocation.recipientMembershipId.trim() || recipients.has(allocation.recipientMembershipId)) {
      throw new TypeError("Split recipients must be unique, non-empty membership identifiers.")
    }
    recipients.add(allocation.recipientMembershipId)
    if (!Number.isInteger(allocation.percentageBasisPoints) || allocation.percentageBasisPoints <= 0) {
      throw new TypeError("Each split percentage must be a positive integer number of basis points.")
    }
    totalBasisPoints += allocation.percentageBasisPoints
    const product = BigInt(baseCents) * BigInt(allocation.percentageBasisPoints)
    return { ...allocation, index, cents: product / BigInt(10_000), remainder: product % BigInt(10_000) }
  })
  if (totalBasisPoints !== 10_000) throw new TypeError("Split percentages must total exactly 10000 basis points (100.00%).")
  let remaining = BigInt(baseCents) - parts.reduce((sum, part) => sum + part.cents, BigInt(0))
  const order = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)
  for (let index = 0; remaining > BigInt(0); index += 1, remaining -= BigInt(1)) order[index % order.length].cents += BigInt(1)
  return parts.map((part) => ({
    recipientMembershipId: part.recipientMembershipId,
    percentageBasisPoints: part.percentageBasisPoints,
    amountCents: safeNumber(part.cents, "distribution amount"),
  }))
}
