import { isSandboxDestination } from "../sandbox/labels"
import type { FunderRoute } from "../funders/contracts"

export const FUNDER_VERIFICATION_SUMMARY = "Provider delivery is untested; routes and credentials show configuration only."

type Route = Pick<FunderRoute, "kind" | "destination">

/** Evidence source shared by the inventory and destination views.
 * Configuration, credentials and successful local fixtures never establish live verification.
 * There are currently no providers with recorded live application-to-reply evidence.
 */
export function providerReadiness(route?: Route | null): "sandbox verified" | "untested" {
  return route?.kind === "api" && (route.destination === "sandbox" || isSandboxDestination(route.destination)) ? "sandbox verified" : "untested"
}

export function providerReadinessLabel(route?: Route | null): string {
  if (!route) return "Unavailable — no active destination."
  if (route.kind === "api" && isSandboxDestination(route.destination)) return "Sandbox simulation only — never delivers to a real provider."
  if (providerReadiness(route) === "sandbox verified") return "Sandbox verified locally — unavailable in production."
  switch (route.kind) {
    case "api": return "Untested — provider access and live delivery are unverified."
    case "email": return "Untested — controlled email application-to-reply pilot pending."
    case "custom_webhook": return "Untested — webhook contract and provider reply are unverified."
    case "manual_portal": return "Untested — manual submission; provider acceptance must be checked separately."
  }
}

/** Call on the server; preserve existing response shapes unless the inventory is enabled. */
export function providerReadinessView(route?: Route | null): { providerReadiness?: string } {
  return process.env.MCA_FUNDER_READINESS_INVENTORY_ENABLED === "true"
    ? { providerReadiness: providerReadinessLabel(route) } : {}
}
