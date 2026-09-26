import { assistantEnabled } from "@/lib/mca/assistant/security"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { DashboardChrome } from "@/components/mca/dashboard-chrome"
import { NewDealProvider } from "@/components/mca/deals/new-deal-provider"
import { authenticateSupabaseSession, supabaseIdentity } from "@/lib/mca/supabase-auth"
import { getTotpAccessState } from "@/lib/mca/totp-service"
import { getSessionResponse } from "@/lib/mca/sessions"
import type { PageKey } from "@/lib/mca/types"
import { PwaLifecycle } from "@/components/mca/pwa-lifecycle"
import { getCompanyAccess } from "@/lib/mca/company-access"
import { isCompanyRecoveryPage } from "@/lib/mca/company-recovery"
import { CompanyPaused } from "@/components/mca/company-paused"
import { unauthenticatedPageGate } from "@/lib/mca/app-paths"

function pageForPath(pathname: string): PageKey | null {
  if (pathname === "/dashboard" || pathname === "/dashboard-2" || pathname.startsWith("/dashboard-2/")) return "dashboard"
  if (["/calendar", "/intake", "/applications", "/assistant", "/sms", "/mail", "/submissions", "/deals", "/pipeline", "/offers", "/advances", "/renewals"].some((path) => pathname === path || pathname.startsWith(`${path}/`))) return "deals"
  if (pathname === "/reports" || pathname.startsWith("/reports/")) return "reports"
  if (pathname === "/payments" || pathname.startsWith("/payments/")) return "payments"
  if (pathname === "/settings/team" || pathname === "/settings/access") return "users"
  if (pathname === "/settings/api-keys") return "integrations"
  if (pathname.startsWith("/settings/connections")) return "integrations"
  if (pathname === "/settings" || pathname.startsWith("/settings/templates")) return "workspace"
  return null
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const headerStore = await headers()
  const pathname = headerStore.get("x-mca-pathname") ?? "/dashboard"
  const context = await authenticateSupabaseSession()
  if (!context && await supabaseIdentity({ allowPasswordSetup: true })) redirect("/onboarding")
  if (!context) {
    const gate = unauthenticatedPageGate(pathname, headerStore.get("x-mca-return-to") ?? "/dashboard")
    if (gate.action === "sign-in") redirect(gate.location)
    notFound()
  }

  const session = await getSessionResponse(context)
  const totp = await getTotpAccessState({ userId: context.userId, sessionId: context.sessionId, workspaceId: context.workspaceId })
  if (totp.enrollmentRequired) redirect("/account-security?required=1")
  if (totp.challengeRequired) redirect("/account-security?challenge=1")
  if (pathname.startsWith("/settings/billing") && !["admin", "super_admin"].includes(context.role)) redirect("/errors/forbidden")
  const access = await getCompanyAccess(context.workspaceId)
  if (!access.allowed && !isCompanyRecoveryPage(pathname)) {
    return <CompanyPaused canManage={["admin", "super_admin"].includes(context.role)} />
  }
  const page = pageForPath(pathname)
  if (page && !session.permissions?.pages[page]) redirect(`/errors/forbidden?from=${encodeURIComponent(pathname)}`)
  if (page === "payments" && !session.permissions?.actions.viewPaymentTable) redirect(`/errors/forbidden?from=${encodeURIComponent(pathname)}`)

  return <><NewDealProvider><DashboardChrome session={session} fullBleed={pathname === "/assistant"} assistantEnabled={assistantEnabled(context) && Boolean(session.permissions?.pages.deals)} assistantDomainKey={process.env.MCA_ASSISTANT_DOMAIN_KEY ?? ""} assistantRuntime={["supabase", "vercel_node"].includes(process.env.MCA_ASSISTANT_RUNTIME ?? "") ? "supabase" : "chatkit"}>{children}</DashboardChrome></NewDealProvider><PwaLifecycle /></>
}
