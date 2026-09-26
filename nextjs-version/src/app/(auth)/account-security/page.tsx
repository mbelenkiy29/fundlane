import { redirect } from "next/navigation"
import { supabaseIdentity } from "@/lib/mca/supabase-auth"
import { AuthShell } from "@/components/mca/auth-shell"
import { MfaForm } from "@/components/mca/auth/mfa-form"
import { requirePlatformAdmin } from "@/lib/mca/platform-auth"
import { AppError } from "@/lib/mca/errors"
import Link from "next/link"

export const dynamic = "force-dynamic"

export default async function AccountSecurityPage({ searchParams }: { searchParams: Promise<{ required?: string; challenge?: string }> }) {
  if (!await supabaseIdentity()) redirect("/sign-in?next=%2Faccount-security")
  const params = await searchParams
  let platform = false
  try { await requirePlatformAdmin(); platform = true } catch (error) {
    if (error instanceof AppError && error.code === "mfa_required") platform = true
    else if (!(error instanceof AppError && [401, 403].includes(error.status))) throw error
  }
  const mode = params.challenge === "1" ? "challenge" : params.required === "1" ? "enroll" : "manage"
  return <AuthShell title="Account security" description="Use an authenticator app to protect email and password sign-in. Workspace administrators can require this for every member. Google sign-in does not ask for a second factor after Google authentication.">
    <MfaForm mode={mode} />
    {platform && <Link className="mt-5 block text-sm underline" href="/platform">Continue to platform administration</Link>}
  </AuthShell>
}
