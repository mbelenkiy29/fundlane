import { assistantEnabled } from "@/lib/mca/assistant/security"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { DashboardChrome } from "@/components/mca/dashboard-chrome"
import { authenticateClerkSession } from "@/lib/mca/clerk-auth"
import { auth } from "@clerk/nextjs/server"
import { getSessionResponse } from "@/lib/mca/sessions"
import type { PageKey } from "@/lib/mca/types"
import { PwaLifecycle } from "@/components/mca/pwa-lifecycle"

function pageForPath(pathname: string): PageKey | null {
  if (pathname === "/dashboard") return "dashboard"
  if (["/assistant", "/sms", "/submissions", "/deals", "/offers", "/advances", "/renewals"].some((path) => pathname === path || pathname.startsWith(`${path}/`))) return "deals"
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
  const context = await authenticateClerkSession()
  if (!context && (await auth()).userId) redirect("/onboarding")
  if (!context) redirect(`/sign-in?returnTo=${encodeURIComponent(headerStore.get("x-mca-return-to") ?? "/dashboard")}`)

  const session = await getSessionResponse(context)
  const pathname = headerStore.get("x-mca-pathname") ?? "/dashboard"
  if (pathname.startsWith("/settings/billing") && !["admin", "super_admin"].includes(context.role)) redirect("/errors/forbidden")
  const page = pageForPath(pathname)
  if (page && !session.permissions?.pages[page]) redirect(`/errors/forbidden?from=${encodeURIComponent(pathname)}`)
  if (page === "payments" && !session.permissions?.actions.viewPaymentTable) redirect(`/errors/forbidden?from=${encodeURIComponent(pathname)}`)

  return <><DashboardChrome session={session} assistantEnabled={assistantEnabled(context) && Boolean(session.permissions?.pages.deals)} assistantDomainKey={process.env.MCA_ASSISTANT_DOMAIN_KEY ?? ""}>{children}</DashboardChrome><PwaLifecycle /></>
}
