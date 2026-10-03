import Link from "next/link"
import { AuthShell } from "@/components/mca/auth-shell"
import { EnrollmentCompletion } from "@/components/mca/onboarding/enrollment-completion"
import { parseEnrollmentContinuation } from "@/lib/mca/auth-navigation"
import { readEnrollmentAuthCookie, requireIssuedEnrollmentChallenge } from "@/lib/mca/onboarding/auth"
import { getSupportConfig } from "@/lib/marketing/support-config"

export const dynamic = "force-dynamic"
export const metadata = { title: "Complete your purchase | Fundlane", robots: { index: false, follow: false } }

/** Only a live emailed invite bound to this browser and this exact locator offers set-password; it is read, not consumed. */
async function pendingInvite(locator: string): Promise<{ challengeId: string; email: string } | undefined> {
  const cookie = await readEnrollmentAuthCookie()
  if (!cookie) return undefined
  try {
    const { challenge, payload } = await requireIssuedEnrollmentChallenge(cookie.id, locator)
    return payload.invite ? { challengeId: challenge.id, email: payload.email } : undefined
  } catch { return undefined }
}

export default async function EnrollmentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams, query = new URLSearchParams()
  for (const key of ["enrollment", "destination", "generation"]) {
    const values = params[key]
    for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) query.append(key, value)
  }
  const continuation = parseEnrollmentContinuation(`/enrollment?${query}`)
  const invite = continuation ? await pendingInvite(`/enrollment?${query}`) : undefined
  return <AuthShell title="Complete your purchase" description="Confirm your trial and securely enter your workspace.">
    {continuation ? <EnrollmentCompletion continuation={continuation} supportEmail={getSupportConfig().supportEmail} {...(invite ? { invite } : {})} /> : <div className="space-y-4"><p role="alert">This purchase link is invalid. Open the latest link from your email or contact support.</p><Link className="underline" href="/sign-in">Login</Link></div>}
  </AuthShell>
}
