import { AppError } from "./errors"
import { signupMode } from "./signup-mode"
import { authContinuation } from "./auth-navigation"

export async function assertAccountSignupAllowed(email: string, next?: string): Promise<void> {
  if (signupMode() !== "invite_only") return
  const destination = new URL(authContinuation(next ?? null), "https://auth.invalid")
  const token = destination.pathname === "/accept-invite" ? destination.searchParams.get("token") : null
  if (!token) throw new AppError(403, "signup_invite_only", "Fundlane is invite-only. Book a demo to get started.")
  const { inspectSupabaseInvitation } = await import("./supabase-team")
  const invitation = await inspectSupabaseInvitation(token)
  if (invitation.email.toLowerCase() !== email.toLowerCase()) {
    throw new AppError(403, "invitation_account_mismatch", "Use the email address invited to this company.")
  }
}

export function requireOpenSignup(): void {
  if (signupMode() === "invite_only") {
    throw new AppError(403, "signup_invite_only", "Fundlane is invite-only. Book a demo to get started.")
  }
}
