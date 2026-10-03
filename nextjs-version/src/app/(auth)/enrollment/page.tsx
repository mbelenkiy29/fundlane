import Link from "next/link"
import { z } from "zod"
import { AuthShell } from "@/components/mca/auth-shell"
import { EnrollmentCompletion } from "@/components/mca/onboarding/enrollment-completion"
import { parseEnrollmentContinuation } from "@/lib/mca/auth-navigation"
import { getSupportConfig } from "@/lib/marketing/support-config"

export const dynamic = "force-dynamic"
export const metadata = { title: "Complete your purchase | Fundlane", robots: { index: false, follow: false }, referrer: "no-referrer" as const }

export default async function EnrollmentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams, query = new URLSearchParams()
  for (const key of ["enrollment", "destination", "generation"]) {
    const values = params[key]
    for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) query.append(key, value)
  }
  const continuation = parseEnrollmentContinuation(`/enrollment?${query}`)
  // The invite id is a non-secret locator; its token stays in the URL fragment, and this GET reads nothing about it.
  const inviteId = typeof params.invite === "string" && z.uuid().safeParse(params.invite).success ? params.invite : undefined
  return <AuthShell title="Complete your purchase" description="Confirm your trial and securely enter your workspace.">
    {continuation ? <EnrollmentCompletion continuation={continuation} supportEmail={getSupportConfig().supportEmail} {...(inviteId ? { inviteId } : {})} /> : <div className="space-y-4"><p role="alert">This purchase link is invalid. Open the latest link from your email or contact support.</p><Link className="underline" href="/sign-in">Login</Link></div>}
  </AuthShell>
}
