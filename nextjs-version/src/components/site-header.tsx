"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { AssistantButton } from "@/components/mca/assistant/assistant-panel"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { CreditNotificationBell } from "@/components/mca/assistant/notification-bell"
import { useOptionalNewDeal } from "@/components/mca/deals/new-deal-provider"
import { ModeToggle } from "@/components/mode-toggle"
import type { SessionResponse } from "@/lib/mca/types"

export function SiteHeader({ session }: { session?: SessionResponse }) {
  const newDeal = useOptionalNewDeal()
  const pathname = usePathname()
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex w-full items-center gap-2 px-4 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <div className="ml-auto flex items-center gap-1">
          {session?.permissions?.actions.createDeal && newDeal ? (
            <Button type="button" size="sm" className="hidden sm:inline-flex" onClick={() => newDeal.open()}>
              <Plus /> New deal
            </Button>
          ) : null}
          <CreditNotificationBell canManage={["admin", "super_admin"].includes(session?.membership?.role ?? "")} />
          {session?.platformOwner && <Link href="/admin/status" className="rounded px-2 py-1 text-sm hover:bg-muted">Platform status</Link>}
          {pathname !== "/assistant" && <AssistantButton />}
          <ModeToggle />
        </div>
      </div>
    </header>
  )
}
