"use client"

import { useEffect, useRef, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { PLATFORM_REFRESH_EVENT, startPlatformRefresh } from "@/lib/mca/platform-refresh"

export function PlatformLiveRefresh() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const busy = useRef(false)
  useEffect(() => { busy.current = pending }, [pending])
  const refresh = () => {
    if (busy.current) return
    busy.current = true
    window.dispatchEvent(new Event(PLATFORM_REFRESH_EVENT))
    startTransition(() => router.refresh())
  }
  useEffect(() => startPlatformRefresh(() => {
    if (busy.current) return
    busy.current = true
    window.dispatchEvent(new Event(PLATFORM_REFRESH_EVENT))
    startTransition(() => router.refresh())
  }), [router])
  return <Button type="button" variant="outline" size="sm" disabled={pending} onClick={refresh} title="Updates every 30 seconds while this tab is visible">{pending ? "Refreshing…" : "Refresh data"}</Button>
}
