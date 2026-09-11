"use client"
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Bell } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover"
import { assistantJson } from "./credit-balance"
type Notice = {
  workspaceId: string
  id: string
  kind: string
  userName: string
  companyName: string
  total: number
  resetAt: string
  userId: string
  readAt: string | null
  emailState: string
}
export function CreditNotificationBell({ canManage }: { canManage: boolean }) {
  const [state, setState] = useState<{
      unread: number
      notifications: Notice[]
    }>({ unread: 0, notifications: [] }),
    [error, setError] = useState("")
  const refresh = useCallback(() => {
    if (canManage)
      void assistantJson<typeof state>("/api/mca/assistant/notifications")
        .then((d) => {
          setState(d)
          setError("")
        })
        .catch(() => setError("Notifications could not be loaded."))
  }, [canManage])
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 30000)
    window.addEventListener("focus", refresh)
    window.addEventListener("mca-credits-changed", refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
      window.removeEventListener("mca-credits-changed", refresh)
    }
  }, [refresh])
  async function read(id: string) {
    try {
      await assistantJson("/api/mca/assistant/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      })
      refresh()
    } catch {
      setError("Could not mark this alert as read.")
    }
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications${state.unread ? `, ${state.unread} unread` : ""}`}
        >
          <Bell className="size-4" />
          {state.unread > 0 && (
            <span className="absolute right-0 top-0 min-w-4 rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
              {state.unread > 99 ? "99+" : state.unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[65vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
      >
        <h2 className="mb-3 font-medium">Notifications</h2>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!state.notifications.length && (
          <p className="text-sm text-muted-foreground">
            {canManage
              ? "No credit alerts yet."
              : "Company credit alerts are sent to your administrators."}
          </p>
        )}
        <ul className="divide-y">
          {state.notifications.map((n) => (
            <li className="space-y-2 py-3 text-sm" key={n.id}>
              <p className={!n.readAt ? "font-semibold" : ""}>
                {n.userName}{" "}
                {n.kind === "exhausted"
                  ? "has no AI credits left"
                  : "is running low on AI credits"}
              </p>
              <p className="text-xs text-muted-foreground">
                {n.total} credits left · {n.companyName} · resets{" "}
                {new Date(n.resetAt).toLocaleDateString()}
              </p>
              <div className="flex items-center justify-between gap-2">
                <Link
                  className="underline"
                  href={`/assistant/credits?workspace=${encodeURIComponent(n.workspaceId)}&user=${encodeURIComponent(n.userId)}`}
                >
                  Manage credits
                </Link>
                {!n.readAt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void read(n.id)}
                  >
                    Mark read
                  </Button>
                )}
              </div>
              {["queued", "failed", "uncertain", "retry"].includes(
                n.emailState
              ) && (
                <p className="text-xs text-muted-foreground">
                  Email: {n.emailState}
                </p>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
