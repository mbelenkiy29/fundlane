"use client"
import { useCallback, useEffect, useState } from "react"
import { requestJson } from "@/lib/mca/client"
import type { MailboxReadiness } from "@/lib/mca/senders/readiness"
import { PersonalEmailConnections } from "./connections"

const consumerCopy = {
  disabled: "Conversation processing needs activation by your administrator.",
  missing: "Conversation processing has not completed its first check.",
  stale: "Conversation processing needs attention from your administrator.",
  healthy: "Conversation processing is running.",
}

/** Reusable onboarding step; the main checklist owns completion and navigation. */
export function CompanyMailboxConnections({ onChanged }: { onChanged?: () => void }) {
  const [readiness, setReadiness] = useState<MailboxReadiness>()
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    try {
      setReadiness(await requestJson<MailboxReadiness>("/api/mca/senders/readiness"))
      setError("")
    } catch (e) {
      setReadiness(undefined)
      setError(e instanceof Error ? e.message : "Unable to check work email.")
    }
  }, [])
  useEffect(() => {
    const initial = setTimeout(() => { void refresh() }, 0)
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 15000)
    return () => { clearTimeout(initial); clearInterval(timer) }
  }, [refresh])
  return (
    <section aria-label="Company work email" className="space-y-3">
      <h3 className="font-medium">Connect your company work email</h3>
      <p className="text-sm text-muted-foreground">
        Connect Gmail or Microsoft 365 to send merchant messages and sync replies.
        Account and team notifications use the platform email service.
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {readiness && <div role="status" className="space-y-1 text-sm">
        <p>{readiness.ready ? "Work email is ready for conversations." : "Work email setup is incomplete."}</p>
        <p className="text-muted-foreground">{consumerCopy[readiness.consumer.state]}</p>
        {!readiness.providers.google && <p>Gmail needs configuration from your administrator.</p>}
        {!readiness.providers.microsoft && <p>Microsoft 365 needs configuration from your administrator.</p>}
        <p className="text-muted-foreground">A connected account does not confirm message delivery.</p>
      </div>}
      <PersonalEmailConnections onChanged={() => { void refresh(); onChanged?.() }} />
    </section>
  )
}
