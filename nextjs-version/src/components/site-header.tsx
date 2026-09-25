"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { AssistantButton } from "@/components/mca/assistant/assistant-panel"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { CreditNotificationBell } from "@/components/mca/assistant/notification-bell"
import { NewDealHeaderAction } from "@/components/mca/deals/new-deal-header-action"
import { useOptionalNewDeal } from "@/components/mca/deals/new-deal-provider"
import { ModeToggle } from "@/components/mode-toggle"
import type { SessionResponse } from "@/lib/mca/types"

export function SiteHeader({ session }: { session?: SessionResponse }) {
  const newDeal = useOptionalNewDeal()
  const pathname = usePathname()
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center overflow-x-clip border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex w-full min-w-0 items-center gap-2 px-4 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <div className="ml-auto flex min-w-0 items-center justify-end gap-1">
          {session?.permissions?.actions.createDeal && newDeal && (
            <NewDealHeaderAction onOpen={() => newDeal.open()} />
          )}
          <CreditNotificationBell canManage={["admin", "super_admin"].includes(session?.membership?.role ?? "")} />
          {session?.platformOwner && <Link href="/admin/status" className="rounded px-2 py-1 text-sm hover:bg-muted">Platform status</Link>}
          {pathname !== "/assistant" && <AssistantButton />}
          <ModeToggle />
        </div>
      </div>
    </header>
  )
}
