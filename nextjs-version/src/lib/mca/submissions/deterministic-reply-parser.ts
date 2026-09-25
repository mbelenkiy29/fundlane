import type { ClassifiedReplyOutcome, ReplyOutcomeClassifierInput, TermNumber, TermString } from "./extract-outcomes"

const unknownNumber: TermNumber = { value: null, unknown: true }
const unknownString: TermString = { value: null, unknown: true }

function numberAfter(source: string, label: RegExp, money = false): TermNumber {
  const match = source.match(label)
  if (!match?.[1]) return unknownNumber
  const value = Number(match[1].replace(/,/g, ""))
  if (!Number.isFinite(value) || value <= 0) return unknownNumber
  const multiplier = money && match[2]?.toLowerCase() === "k" ? 1000 : 1
  return { value: value * multiplier, unknown: false, evidence: match[0] }
}

function stringAfter(source: string, pattern: RegExp): TermString {
  const match = source.match(pattern)
  return match?.[1] ? { value: match[1].toLowerCase(), unknown: false, evidence: match[0] } : unknownString
}

/** Conservative fallback: only labeled terms are accepted; unclear mail stays in review. */
export function parseReplyDeterministically(input: ReplyOutcomeClassifierInput): ClassifiedReplyOutcome {
  const source = `${input.subject}\n${input.body}`
  const amount = numberAfter(source, /\b(?:approved|offer|funding|advance)\s+(?:amount\s*)?(?:for|of|:|is)?\s*\$\s*([\d,]+(?:\.\d{1,2})?)\s*(k)?\b/i, true)
  const rate = numberAfter(source, /\b(?:factor(?:\s+rate)?|rate)\s*(?:of|:|is)?\s*(1\.\d{1,3})\b/i)
  const term = numberAfter(source, /\bterm\s*(?:of|:|is)?\s*(\d{1,3})\s*(?:months?|mos?)\b/i)
  const paymentAmount = numberAfter(source, /\b(?:daily|weekly|monthly)?\s*payment\s*(?:amount\s*)?(?:of|:|is)?\s*\$\s*([\d,]+(?:\.\d{1,2})?)\b/i, true)
  const frequency = stringAfter(source, /\b(daily|weekly|biweekly|monthly)\s+payments?\b/i)
  const decline = /\b(?:declin(?:e|ed)|unable to (?:approve|offer|fund)|cannot approve|not approved)\b/i.exec(source)
  const stipMatches = [...source.matchAll(/(?:^|[\n.;])\s*(?:please (?:send|provide|upload)|we (?:need|require))\s+([^\n.;]{4,200})/gi)]
  const stipulations = stipMatches.map((match) => ({ text: match[1].trim(), evidence: match[0].trim() }))
  const approval = /\b(?:approved|offer(?:ing)?|terms? (?:are|is))\b/i.test(source)
  const classification = decline ? "decline" : approval || !amount.unknown ? "approval" : stipulations.length ? "pending" : "unparseable"
  const declineReason = decline ? (() => {
    const sentence = source.slice(decline.index).split(/[\n.]/)[0]?.trim() ?? ""
    return sentence.length <= 240 ? sentence : sentence.slice(0, 240)
  })() : undefined
  return {
    classification,
    confidence: classification === "unparseable" ? 0 : 0.7,
    amount, rate, term, paymentAmount, frequency,
    commission: unknownNumber, fees: [], offerLink: unknownString,
    stipulations, declineReason: declineReason ? { value: declineReason, unknown: false, evidence: declineReason } : unknownString,
    summary: classification === "unparseable" ? "Could not determine a funder outcome; review the original reply." : "Parsed from labeled reply text.",
    warnings: ["Deterministic extraction; confirm all terms against the original email."],
    provider: "deterministic",
  }
}
