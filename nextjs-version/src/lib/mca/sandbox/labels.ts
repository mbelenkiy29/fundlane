/** Client-safe sandbox labels. Never treat this funder as a real lender. */

export const SANDBOX_FUNDER_IDEMPOTENCY_KEY = "fundlane-sandbox-funder"
export const SANDBOX_ROUTE_DESTINATION = "fundlane-sandbox"
export const SANDBOX_DOMAIN = "sandbox.fundlane.invalid"
export const SANDBOX_LEGAL_NAME = "[SANDBOX] Fundlane Demo Funder — not a real lender"
export const SANDBOX_NICKNAME = "SANDBOX DEMO"
export const SANDBOX_PRODUCT = "[SANDBOX] Synthetic MCA — not a real funding commitment"
export const SANDBOX_DECLINE_MARKER = "SANDBOX-DECLINE"
export const SANDBOX_WARNING =
  "This is a workspace-only sandbox funder for QA and sales demos. It never emails, texts, or calls a real lender, and it never touches another workspace."

export function isSandboxDestination(destination?: string | null): boolean {
  return (destination ?? "").trim().toLowerCase() === SANDBOX_ROUTE_DESTINATION
}

export function isSandboxFunder(funder: {
  sandbox?: boolean
  idempotencyKey?: string
  legalName?: string
  nickname?: string
  domains?: string[]
  routes?: Array<{ destination?: string }>
}): boolean {
  if (funder.sandbox === true) return true
  if (funder.idempotencyKey === SANDBOX_FUNDER_IDEMPOTENCY_KEY) return true
  if (funder.legalName === SANDBOX_LEGAL_NAME) return true
  if (funder.nickname === SANDBOX_NICKNAME) return true
  if (funder.domains?.some((domain) => domain.trim().toLowerCase() === SANDBOX_DOMAIN)) return true
  return Boolean(funder.routes?.some((route) => isSandboxDestination(route.destination)))
}

export function sandboxDeclineRequested(legalName?: string | null): boolean {
  return (legalName ?? "").toUpperCase().includes(SANDBOX_DECLINE_MARKER)
}
