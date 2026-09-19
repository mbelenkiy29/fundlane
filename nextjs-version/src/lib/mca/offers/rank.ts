export function pickHighestMerchantOffer<T extends { amountCents: number; factorRate?: number; revisionId: string }>(offers: T[]): T {
  if (!offers.length) throw new Error("No offers to rank.")
  return [...offers].sort((left, right) => {
    if (right.amountCents !== left.amountCents) return right.amountCents - left.amountCents
    const leftFactor = left.factorRate ?? Number.POSITIVE_INFINITY
    const rightFactor = right.factorRate ?? Number.POSITIVE_INFINITY
    if (leftFactor !== rightFactor) return leftFactor - rightFactor
    return left.revisionId.localeCompare(right.revisionId)
  })[0]!
}
