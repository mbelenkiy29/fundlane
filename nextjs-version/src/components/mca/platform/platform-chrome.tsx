"use client"

import { useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Activity, ArrowLeft, Building2, CircleGauge, ClipboardList, Map, MessageSquare, ShieldCheck, WalletCards } from "lucide-react"
import { Logo } from "@/components/logo"
import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import { ModeToggle } from "@/components/mode-toggle"
import { SiteFooter } from "@/components/site-footer"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { PlatformLiveRefresh } from "./live-refresh"
import { FeedbackMenu } from "@/components/observability/feedback-menu"
import { SentrySession } from "@/components/observability/sentry-session"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar"

export function PlatformChrome({ children, userId, email, roadmapEnabled }: { children: React.ReactNode; userId: string; email: string; roadmapEnabled: boolean }) {
  return <SidebarProvider style={{ "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem", "--header-height": "calc(var(--spacing) * 14)" } as React.CSSProperties}>
    <SentrySession user={{ id: userId, email, name: "Super admin" }} platformOperator />
    <PlatformSidebar email={email} roadmapEnabled={roadmapEnabled} />
    <SidebarInset id="platform-content" className="min-w-0 overflow-x-clip">
      <PlatformHeader />
      <div className="@container/main flex min-w-0 flex-1 flex-col gap-6 px-4 py-6 lg:px-6">{children}</div>
      <SiteFooter />
    </SidebarInset>
  </SidebarProvider>
}

function PlatformSidebar({ email, roadmapEnabled }: { email: string; roadmapEnabled: boolean }) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  useEffect(() => { setOpenMobile(false) }, [pathname, setOpenMobile])
  const groups = [
    { label: "Platform", items: [
      { title: "Overview", url: "/platform", icon: CircleGauge },
      { title: "Companies", url: "/platform/companies", icon: Building2 },
      { title: "Payments", url: "/platform/payments", icon: WalletCards },
    ] },
    { label: "Operations", items: [
      { title: "Monitoring", url: "/platform/monitoring", icon: Activity },
      { title: "Trial enrollments", url: "/platform/onboarding", icon: ClipboardList },
      { title: "SMS", url: "/platform/sms", icon: MessageSquare },
    ] },
    { label: "Administration", items: [
      { title: "Audit", url: "/platform/audit", icon: ClipboardList },
      ...(roadmapEnabled ? [{ title: "Roadmap", url: "/platform/roadmap", icon: Map }] : []),
      { title: "Account security", url: "/account-security", icon: ShieldCheck },
    ] },
  ]
  return <Sidebar variant="sidebar" collapsible="icon" side="left">
    <SidebarHeader className="border-b">
      <SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" asChild><Link href="/platform">
        <span className="flex aspect-square size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Logo size={25} aria-hidden="true" /></span>
        <span className="grid min-w-0 flex-1 text-left leading-tight"><span className="truncate text-sm font-semibold">Fundlane</span><span className="truncate text-xs text-muted-foreground">Platform administration</span></span>
      </Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
    </SidebarHeader>
    <SidebarContent data-sentry-unmask><nav aria-label="Platform" onClick={event => { if (event.target instanceof Element && event.target.closest("a")) setOpenMobile(false) }}>{groups.map(group => <NavMain key={group.label} label={group.label} items={group.items.map(item => ({ ...item, isActive: pathname === item.url || (item.url !== "/platform" && pathname.startsWith(`${item.url}/`)) }))} />)}</nav></SidebarContent>
    <SidebarFooter className="border-t"><NavUser platform user={{ name: "Super admin", email, avatar: "" }} /></SidebarFooter>
  </Sidebar>
}

function PlatformHeader() {
  const pathname = usePathname()
  const titles: Record<string, string> = { companies: "Companies", payments: "Payments", monitoring: "Monitoring", onboarding: "Trial enrollments", sms: "SMS", audit: "Audit", roadmap: "Roadmap" }
  const section = pathname.split("/")[2]
  return <header className="sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
    <div className="flex w-full min-w-0 items-center gap-3 px-4 lg:px-6">
      <SidebarTrigger className="-ml-1" />
      <Breadcrumb className="min-w-0" data-sentry-unmask><BreadcrumbList><BreadcrumbItem>{section ? <BreadcrumbLink asChild><Link href="/platform">Platform</Link></BreadcrumbLink> : <BreadcrumbPage>Platform overview</BreadcrumbPage>}</BreadcrumbItem>{section && <><BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbPage>{titles[section] ?? "Platform"}</BreadcrumbPage></BreadcrumbItem></>}</BreadcrumbList></Breadcrumb>
      <div className="ml-auto flex shrink-0 items-center gap-2" data-sentry-unmask><PlatformLiveRefresh /><Badge variant="outline" className="hidden sm:inline-flex"><ShieldCheck /> Super admin</Badge><Button variant="ghost" size="sm" asChild><Link href="/dashboard"><ArrowLeft className="size-4" /><span className="hidden md:inline">Dashboard</span><span className="sr-only md:hidden">Return to dashboard</span></Link></Button><FeedbackMenu /><ModeToggle /></div>
    </div>
  </header>
}
