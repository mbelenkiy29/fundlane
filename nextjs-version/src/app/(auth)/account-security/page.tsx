import { redirect } from "next/navigation"
import { supabaseIdentity } from "@/lib/mca/supabase-auth"
import { AuthShell } from "@/components/mca/auth-shell"
import { MfaForm } from "@/components/mca/auth/mfa-form"
import { superAdminContinuation } from "@/lib/mca/platform-auth"
import { enrollmentContinuation, parseEnrollmentContinuation } from "@/lib/mca/auth-navigation"

export const dynamic = "force-dynamic"

export default async function AccountSecurityPage({ searchParams }: { searchParams: Promise<{ required?: string; challenge?: string; next?: string }> }) {
  const params = await searchParams
  const enrollment = typeof params.next === "string" ? parseEnrollmentContinuation(params.next) : null
  const enrollmentNext = enrollment ? enrollmentContinuation(enrollment) : null
  if (!await supabaseIdentity()) redirect(`/sign-in?next=${encodeURIComponent(enrollmentNext ? `/account-security?next=${encodeURIComponent(enrollmentNext)}` : "/account-security")}`)
  const ownerContinuation = await superAdminContinuation()
  const continuation = enrollmentNext ?? ownerContinuation ?? "/onboarding"
  const mode = (ownerContinuation && !enrollmentNext) || params.challenge === "1" ? "challenge" : params.required === "1" ? "enroll" : "manage"
  return <AuthShell title="Account security" description="Use an authenticator app to protect email and password sign-in. Workspace administrators can require this for every member. Google sign-in does not ask for a second factor after Google authentication.">
    <MfaForm mode={mode} continueTo={continuation} />
  </AuthShell>
}
