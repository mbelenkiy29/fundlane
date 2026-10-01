import { redirect } from "next/navigation"
import CompanyOnboarding from "@/components/mca/auth/company-onboarding"
import { superAdminContinuation } from "@/lib/mca/platform-auth"

export const dynamic = "force-dynamic"

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ switch?: string; setup?: string }> }) {
  const params = await searchParams
  // Owners can still deliberately switch companies or resume company setup.
  if (params.switch !== "1" && params.setup !== "1") {
    const continuation = await superAdminContinuation()
    if (continuation) redirect(continuation)
  }
  return <CompanyOnboarding />
}
