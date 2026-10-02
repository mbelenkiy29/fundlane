import Link from "next/link"
import { AuthShell } from "@/components/mca/auth-shell"
import { EnrollmentCompletion } from "@/components/mca/onboarding/enrollment-completion"
import { parseEnrollmentContinuation } from "@/lib/mca/auth-navigation"
import { getSupportConfig } from "@/lib/marketing/support-config"

export const dynamic = "force-dynamic"
export const metadata = { title: "Complete your purchase | Fundlane", robots: { index: false, follow: false } }

export default async function EnrollmentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams, query = new URLSearchParams()
  for (const key of ["enrollment", "destination", "generation"]) {
    const values = params[key]
    for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) query.append(key, value)
  }
  const continuation = parseEnrollmentContinuation(`/enrollment?${query}`)
  return <AuthShell title="Complete your purchase" description="Confirm your trial and securely enter your workspace.">
    {continuation ? <EnrollmentCompletion continuation={continuation} supportEmail={getSupportConfig().supportEmail} /> : <div className="space-y-4"><p role="alert">This purchase link is invalid. Open the latest link from your email or contact support.</p><Link className="underline" href="/sign-in">Login</Link></div>}
  </AuthShell>
}
