import { AppError } from "./errors"
import { signupMode } from "./signup-mode"
import { authContinuation } from "./auth-navigation"

/** Rollout intent remains binding when provider configuration or creation is unavailable. */
export function stripeFirstSignupRequired(): boolean {
  return process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED === "true"
}

function signupDenied(): never {
  if (signupMode() === "invite_only") throw new AppError(403, "signup_invite_only", "Fundlane is invite-only. Book a demo to get started.")
  throw new AppError(403, "signup_enrollment_required", "Start your free trial from Pricing before creating a company.")
}

export async function assertAccountSignupAllowed(email: string, next?: string): Promise<void> {
  if (signupMode() !== "invite_only" && !stripeFirstSignupRequired()) return
  const destination = new URL(authContinuation(next ?? null), "https://auth.invalid")
  const token = destination.pathname === "/accept-invite" ? destination.searchParams.get("token") : null
  if (!token) signupDenied()
  const { inspectSupabaseInvitation } = await import("./supabase-team")
  const invitation = await inspectSupabaseInvitation(token)
  if (invitation.email.toLowerCase() !== email.toLowerCase()) {
    throw new AppError(403, "invitation_account_mismatch", "Use the email address invited to this company.")
  }
}

export function requireOpenSignup(): void {
  if (signupMode() === "invite_only" || stripeFirstSignupRequired()) signupDenied()
}
