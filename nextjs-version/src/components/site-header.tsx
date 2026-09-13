"use client"

import { AssistantButton } from "@/components/mca/assistant/assistant-panel"
import * as React from "react"
import { Plus, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { CommandSearch } from "@/components/command-search"
import { CreditNotificationBell } from "@/components/mca/assistant/notification-bell"
import { useOptionalNewDeal } from "@/components/mca/deals/new-deal-provider"
import { ModeToggle } from "@/components/mode-toggle"
import type { SessionResponse } from "@/lib/mca/types"

export function SiteHeader({ session }: { session?: SessionResponse }) {
  const newDeal = useOptionalNewDeal()
  const [searchOpen, setSearchOpen] = React.useState(false)
  React.useEffect(() => {
    const down = (event: KeyboardEvent) => { if (event.key === "k" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); setSearchOpen((open) => !open) } }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])
  return <>
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex w-full items-center gap-2 px-4 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Button variant="outline" className="h-9 min-w-0 flex-1 justify-start text-muted-foreground sm:max-w-sm" onClick={() => setSearchOpen(true)}><Search className="size-4" /><span className="truncate">Search merchants, deals, or contacts</span><kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] sm:inline">⌘K</kbd></Button>
        <div className="ml-auto flex items-center gap-1">{session?.permissions?.actions.createDeal && newDeal && <Button type="button" size="sm" className="hidden sm:inline-flex" onClick={() => newDeal.open()}><Plus /> New deal</Button>}<CreditNotificationBell canManage={["admin","super_admin"].includes(session?.membership?.role ?? "")} /><AssistantButton /><ModeToggle /></div>
      </div>
    </header>
    <CommandSearch open={searchOpen} onOpenChange={setSearchOpen} />
  </>
}
