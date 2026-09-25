"use client"

import { AssistantProvider } from "@/components/mca/assistant/assistant-panel"
import { AppSidebar } from "@/components/app-sidebar"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import type { SessionResponse } from "@/lib/mca/types"

export function DashboardChrome({ children, session, assistantEnabled = false, assistantDomainKey = "", assistantRuntime = "chatkit", fullBleed = false }: { children: React.ReactNode; session: SessionResponse; assistantEnabled?: boolean; assistantDomainKey?: string; assistantRuntime?: "chatkit" | "supabase"; fullBleed?: boolean }) {
  const chrome = <SidebarProvider style={{ "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem", "--header-height": "calc(var(--spacing) * 14)" } as React.CSSProperties}>
    <AppSidebar variant="sidebar" collapsible="icon" side="left" session={session} />
    <SidebarInset className={fullBleed ? "min-h-svh min-w-0 overflow-hidden" : "min-w-0 overflow-x-clip"}>
      <SiteHeader session={session} />
      {fullBleed
        ? <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
        : <><div className="flex min-w-0 flex-1 flex-col"><div className="@container/main flex min-w-0 flex-1 flex-col gap-2"><div className="flex min-w-0 flex-col gap-4 py-4 md:gap-6 md:py-6">{children}</div></div></div><SiteFooter /></>}
    </SidebarInset>
  </SidebarProvider>
  return assistantEnabled ? <AssistantProvider key={`${session.user?.id}:${session.membership?.workspaceId}`} domainKey={assistantDomainKey} runtime={assistantRuntime}>{chrome}</AssistantProvider> : chrome
}
