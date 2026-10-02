import { redirect } from "next/navigation"
import { supabaseIdentity } from "@/lib/mca/supabase-auth"
import { AuthShell } from "@/components/mca/auth-shell"
import { MfaForm } from "@/components/mca/auth/mfa-form"
import { superAdminContinuation } from "@/lib/mca/platform-auth"

export const dynamic = "force-dynamic"

export default async function AccountSecurityPage({ searchParams }: { searchParams: Promise<{ required?: string; challenge?: string; next?:string }> }) {
  const params = await searchParams
  if (!await supabaseIdentity()) redirect(params.next==="/activate"?"/sign-in?next=%2Factivate":"/sign-in?next=%2Faccount-security")
  const continuation = params.next==="/activate" ? "/activate" : await superAdminContinuation()
  const mode = continuation || params.challenge === "1" ? "challenge" : params.required === "1" ? "enroll" : "manage"
  return <AuthShell title="Account security" description="Use an authenticator app to protect email and password sign-in. Workspace administrators can require this for every member. Google sign-in does not ask for a second factor after Google authentication.">
    <MfaForm mode={mode} continueTo={continuation ?? "/onboarding"} />
  </AuthShell>
}
