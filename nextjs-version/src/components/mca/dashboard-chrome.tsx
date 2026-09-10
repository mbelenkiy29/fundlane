"use client"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import type { SessionResponse } from "@/lib/mca/types"

export function DashboardChrome({ children, session }: { children: React.ReactNode; session: SessionResponse }) {
  return <SidebarProvider style={{ "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem", "--header-height": "calc(var(--spacing) * 14)" } as React.CSSProperties}>
    <AppSidebar variant="sidebar" collapsible="icon" side="left" session={session} />
    <SidebarInset><SiteHeader session={session} /><div className="flex flex-1 flex-col"><div className="@container/main flex flex-1 flex-col gap-2"><div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">{children}</div></div></div><SiteFooter /></SidebarInset>
  </SidebarProvider>
}
