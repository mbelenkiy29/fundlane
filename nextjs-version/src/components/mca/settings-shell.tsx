"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Building2, KeyRound, Link2, Mail, ShieldCheck, UserRound, UsersRound } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PageVisibility } from "@/lib/mca/types"

const sections = [
  { href: "/settings", label: "Workspace", icon: Building2, page: "workspace" },
  { href: "/settings/business", label: "Business details", icon: Building2, page: "integrations" },
  { href: "/getting-started", label: "Getting started", icon: Building2, page: "integrations" },
  { href: "/settings/team", label: "Team", icon: UsersRound, page: "users" },
  { href: "/settings/access", label: "Access", icon: ShieldCheck, page: "users" },
  { href: "/settings/api-keys", label: "API keys", icon: KeyRound, page: "integrations" },
  { href: "/settings/connections", label: "Connections", icon: Link2, page: "integrations" },
  { href: "/settings/templates", label: "Templates", icon: Mail, page: "workspace" },
  { href: "/settings/profile", label: "My profile", icon: UserRound },
  { href: "/settings/billing", label: "Plans & Billing", icon: Building2 },
]

export function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [pages, setPages] = React.useState<PageVisibility | undefined>()
  const [billingAdmin, setBillingAdmin] = React.useState(false)
  React.useEffect(() => { fetch("/api/auth/session", { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject()).then((session) => { setPages(session.permissions?.pages); setBillingAdmin(["admin", "super_admin"].includes(session.membership?.role)) }).catch(() => undefined) }, [])
  return <div className="mx-auto w-full max-w-7xl px-4 lg:px-6">
    <div className="mb-6"><h1 className="text-2xl font-semibold tracking-tight">Settings</h1><p className="mt-1 text-sm text-muted-foreground">Manage your brokerage, team access, and integrations.</p></div>
    <div className="grid gap-6 lg:grid-cols-[210px_minmax(0,1fr)]">
      <nav aria-label="Settings" className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
        {sections.filter((item) => (item.href !== "/settings/billing" || billingAdmin) && (!item.page || pages?.[item.page as keyof PageVisibility])).map(({ href, label, icon: Icon }) => {
          const active = href === "/settings" ? pathname === href : pathname.startsWith(href)
          return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "bg-muted text-foreground")}><Icon className="size-4" />{label}</Link>
        })}
      </nav>
      <main className="min-w-0">{children}</main>
    </div>
  </div>
}
