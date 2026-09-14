"use client"

import Link from "next/link"
import { CalendarDays, Bot, BanknoteArrowDown, BriefcaseBusiness, Building2, ChartNoAxesCombined, CircleGauge, Columns3, FileCheck2, HandCoins, Landmark, LayoutPanelLeft, RefreshCcw, Settings, Mail, MessageSquare, WalletCards } from "lucide-react"
import { Logo } from "@/components/logo"
import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import type { SessionResponse } from "@/lib/mca/types"

const groups = [
  { label: "Pipeline", items: [
    { title: "Home", url: "/dashboard", icon: CircleGauge, page: "dashboard" },
    { title: "AI Assistant", url: "/assistant", icon: Bot, page: "deals" },
    { title: "Applications", url: "/applications", icon: FileCheck2, page: "deals" },
    { title: "Application Intake", url: "/intake", icon: FileCheck2, page: "deals" },
    { title: "Deals", url: "/deals", icon: BriefcaseBusiness, page: "deals" },
    { title: "Pipeline", url: "/pipeline", icon: Columns3, page: "deals" },
    { title: "Calendar", url: "/calendar", icon: CalendarDays, page: "deals" },
    { title: "Submissions", url: "/submissions", icon: FileCheck2, page: "deals" },
    { title: "Offers", url: "/offers", icon: HandCoins, page: "deals" },
    { title: "Advances", url: "/advances", icon: BanknoteArrowDown, page: "deals" },
    { title: "Renewals", url: "/renewals", icon: RefreshCcw, page: "deals" },
  ]},
  { label: "Operations", items: [
    { title: "Email inbox", url: "/mail", icon: Mail, page: "deals" },
    { title: "SMS inbox", url: "/sms", icon: MessageSquare, page: "deals" },
    { title: "Funders", url: "/funders", icon: Landmark },
    { title: "Payments", url: "/payments", icon: WalletCards, page: "payments" },
    { title: "Reports", url: "/reports", icon: ChartNoAxesCombined, page: "reports" },
    { title: "Analytics", url: "/dashboard-2", icon: LayoutPanelLeft, page: "dashboard" },
    { title: "Settings", url: "/settings", icon: Settings, page: "workspace" },
  ]},
]

export function AppSidebar({ session, ...props }: React.ComponentProps<typeof Sidebar> & { session?: SessionResponse }) {
  const identity = { workspace: session?.membership?.workspaceName ?? "MCA Workspace", name: session?.user?.name ?? "User", email: session?.user?.email ?? "" }
  const pages = session?.permissions?.pages

  return (
    <Sidebar {...props}>
      <SidebarHeader className="border-b">
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" asChild>
          <Link href="/dashboard">
            <div className="flex aspect-square size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Logo size={25} aria-hidden="true" /></div>
            <div className="grid min-w-0 flex-1 text-left leading-tight"><span className="truncate text-sm font-semibold">{identity.workspace}</span><span className="flex items-center gap-1 truncate text-xs text-muted-foreground"><Building2 className="size-3" /> MCA workspace</span></div>
          </Link>
        </SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((group) => <NavMain key={group.label} label={group.label} items={group.items.filter((item) => (!item.page || !session || pages?.[item.page as keyof typeof pages]) && (item.url !== "/payments" || !session || session.permissions?.actions.viewPaymentTable))} />)}
      </SidebarContent>
      <SidebarFooter className="border-t"><NavUser user={{ name: identity.name, email: identity.email, avatar: "" }} /></SidebarFooter>
    </Sidebar>
  )
}
