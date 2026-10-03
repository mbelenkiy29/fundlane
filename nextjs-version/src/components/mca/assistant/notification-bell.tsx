"use client"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { ApplicationNotice } from "@/lib/mca/intake/review-contracts"
import { useCallback, useEffect, useState } from "react"
import { Bell } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover"
import { assistantJson } from "./credit-balance"
import { markCaughtError } from "@/lib/observability/caught-errors"
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
  const router = useRouter()
  const [applications, setApplications] = useState<{ unread: number; notifications: ApplicationNotice[] }>({ unread: 0, notifications: [] })
  const [applicationError, setApplicationError] = useState("")
  const [opening, setOpening] = useState("")
  const [state, setState] = useState<{
      unread: number
      notifications: Notice[]
    }>({ unread: 0, notifications: [] }),
    [error, setError] = useState("")
  const refresh = useCallback(() => {
    void assistantJson<{ unread: number; notifications: ApplicationNotice[] }>("/api/mca/intake/notifications")
      .then(data => { setApplications(data); setApplicationError("") })
      .catch((caught: unknown) => { markCaughtError(caught); setApplicationError("Application alerts could not be loaded.") })
    if (canManage)
      void assistantJson<typeof state>("/api/mca/assistant/notifications")
        .then((d) => {
          setState(d)
          setError("")
        })
        .catch((caught: unknown) => { markCaughtError(caught); setError("Notifications could not be loaded.") })
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
    } catch (caught) {
      markCaughtError(caught)
      setError("Could not mark this alert as read.")
    }
  }
  async function openApplication(notice: ApplicationNotice) {
    setOpening(notice.id)
    try {
      await assistantJson("/api/mca/intake/notifications", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: notice.id })
      })
      refresh()
      router.push(`/intake/${encodeURIComponent(notice.intakeId)}`)
    } catch (caught) { markCaughtError(caught); setApplicationError("Could not mark this application alert as read. Please retry.") }
    finally { setOpening("") }
  }
  const unread = applications.unread + (canManage ? state.unread : 0)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute right-0 top-0 min-w-4 rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[65vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
      >
        <h2 className="mb-3 font-medium">Notifications</h2>
        {(error || applicationError) && (
          <p role="alert" className="text-sm text-destructive">
            {error || applicationError}
          </p>
        )}
        {!applications.notifications.length && (!canManage || !state.notifications.length) && (
          <p className="text-sm text-muted-foreground">
            No notifications yet.
          </p>
        )}
        <ul className="divide-y">
          {applications.notifications.map(notice => (
            <li key={`application-${notice.id}`} className="space-y-2 py-3 text-sm">
              <p className={!notice.readAt ? "font-semibold" : ""}>Application received — {notice.merchantName}</p>
              <p className="text-xs text-muted-foreground">Application {notice.state.replaceAll("_", " ")} · {new Date(notice.createdAt).toLocaleString()}</p>
              <Link className="inline-block underline" aria-disabled={opening === notice.id} href={`/intake/${encodeURIComponent(notice.intakeId)}`} onClick={event => { event.preventDefault(); if (!opening) void openApplication(notice) }}>{opening === notice.id ? "Opening…" : "Review application"}</Link>
            </li>
          ))}
          {canManage && state.notifications.map((n) => (
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
