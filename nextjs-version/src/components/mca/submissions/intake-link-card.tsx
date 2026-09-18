"use client"

import * as React from "react"
import Link from "next/link"
import { Copy, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { RequestError, requestJson } from "@/lib/mca/client"

interface IntakeLink {
  url: string
  membershipId: string
  mailConfigured: boolean
}

export function IntakeLinkCard() {
  const [link, setLink] = React.useState<IntakeLink>()
  const [email, setEmail] = React.useState("")
  const [status, setStatus] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let active = true
    requestJson<IntakeLink>("/api/mca/submissions/intake-link")
      .then((result) => {
        if (active) setLink(result)
      })
      .catch((caught) => {
        if (active) setError(caught instanceof RequestError ? caught.message : "Could not load your application link.")
      })
    return () => {
      active = false
    }
  }, [])

  async function copyLink() {
    if (!link?.url) return
    await navigator.clipboard.writeText(link.url)
    setStatus("Link copied")
    setError(undefined)
  }

  async function sendEmail(event: React.FormEvent) {
    event.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setError(undefined)
    setStatus(undefined)
    try {
      await requestJson("/api/mca/submissions/intake-link", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      })
      setStatus(`Sent to ${email.trim()}`)
      setEmail("")
    } catch (caught) {
      setError(caught instanceof RequestError ? caught.message : "Could not send the application link.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-5">
        <div>
          <p className="text-sm font-medium">Your client application link</p>
          <p className="text-sm text-muted-foreground">
            Email this unique link so a prospect can fill the application and upload bank statements, ID, and a voided check.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input readOnly value={link?.url ?? ""} aria-label="Client application link" placeholder="Loading link…" />
          <Button type="button" variant="outline" onClick={() => void copyLink()} disabled={!link}>
            <Copy className="size-4" /> Copy
          </Button>
        </div>
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => void sendEmail(event)}>
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="client@business.com"
            aria-label="Client email"
          />
          <Button type="submit" disabled={busy || !link}>
            <Mail className="size-4" /> Send to client
          </Button>
        </form>
        {link && !link.mailConfigured ? (
          <p className="text-xs text-muted-foreground">
            Copy works now. Connect email in <Link className="underline" href="/settings">Settings</Link> to send this link.
          </p>
        ) : null}
        {status ? <p className="text-sm text-muted-foreground" role="status">{status}</p> : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      </CardContent>
    </Card>
  )
}
