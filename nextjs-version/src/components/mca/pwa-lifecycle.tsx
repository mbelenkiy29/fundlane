"use client"

import * as React from "react"
import { RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"

export function PwaLifecycle() {
  const [waiting, setWaiting] = React.useState<ServiceWorker | null>(null)

  React.useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return

    const onControllerChange = () => window.location.reload()

    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((next) => {
      if (next.waiting) setWaiting(next.waiting)
      next.addEventListener("updatefound", () => {
        const installing = next.installing
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            setWaiting(installing)
          }
        })
      })
    }).catch(() => {
      // Installation remains optional; the app still works as a normal website.
    })

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
    }
  }, [])

  if (!waiting) return null

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border bg-background p-3 shadow-lg" role="status">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">An MCA update is ready</p>
        <p className="text-xs text-muted-foreground">Refresh when you are ready to use the latest version.</p>
      </div>
      <Button size="sm" onClick={() => waiting.postMessage({ type: "SKIP_WAITING" })}>
        <RefreshCw className="size-4" /> Refresh
      </Button>
      <Button variant="ghost" size="icon" aria-label="Dismiss update" onClick={() => setWaiting(null)}>
        <X className="size-4" />
      </Button>
    </div>
  )
}
