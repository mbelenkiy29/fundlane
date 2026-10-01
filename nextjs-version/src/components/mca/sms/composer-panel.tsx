"use client"

import * as React from "react"
import { Loader2, MessageSquareText } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { SmsAccount, SmsMessage } from "@/lib/mca/sms/contracts"

type ConsentState = "loading" | "unknown" | "opted_in" | "opted_out"
type ComposerAccount = Pick<SmsAccount, "id" | "label" | "provider" | "senderMasked" | "providerConfigured" | "isDefault" | "state">
type ComposerMessage = SmsMessage & { body: string }
type ComposerContext = {
  dealId: string
  merchantName: string
  recipient: string | null
  recipientMasked: string | null
  consent: { state: string; recipientMasked?: string; effectiveAt?: string; source?: string }
  accounts: ComposerAccount[]
  messages: ComposerMessage[]
}
type DirectPreview = {
  recipient: string
  recipientMasked: string
  body: string
  accountId: string
  provider: string
  senderMasked: string
  providerConfigured: boolean
  consentState: string
  canSend: boolean
  block?: { code: string; message: string }
}

const providerLabel: Record<string, string> = {
  twilio: "Twilio",
  entrance: "Entrance",
  texttorrent: "TextTorrent",
  textus: "TextUs",
  openphone: "OpenPhone",
  gohighlevel: "GoHighLevel",
}

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {}).flat().filter(Boolean)
    return fields.length ? fields.join(" ") : error.message
  }
  return error instanceof Error ? error.message : "The text could not be sent."
}

export function smsComposerGate(input: {
  loading: boolean
  recipient: string | null
  accounts: ComposerAccount[]
  selectedAccountId: string
  consent: ConsentState
  body: string
  previewed: boolean
}): { phase: "loading" | "empty" | "blocked" | "validation" | "ready"; sendEnabled: boolean; previewEnabled: boolean; reason: string } {
  if (input.loading) return { phase: "loading", sendEnabled: false, previewEnabled: false, reason: "Loading SMS composer…" }
  if (!input.recipient) return { phase: "empty", sendEnabled: false, previewEnabled: false, reason: "Save a merchant mobile number on this deal before sending a text." }
  if (!input.accounts.length) return { phase: "empty", sendEnabled: false, previewEnabled: false, reason: "Not connected. No text account is available. Ask an administrator to configure one in Settings → Connections." }
  const selected = input.accounts.find((account) => account.id === input.selectedAccountId)
  if (!selected) return { phase: "validation", sendEnabled: false, previewEnabled: false, reason: "Choose a text account." }
  if (!input.body.trim()) return { phase: "validation", sendEnabled: false, previewEnabled: false, reason: "Enter the exact text the merchant will receive." }
  if (input.consent === "opted_out") return { phase: "blocked", sendEnabled: false, previewEnabled: true, reason: "This merchant opted out of text messages." }
  if (input.consent !== "opted_in") return { phase: "blocked", sendEnabled: false, previewEnabled: true, reason: "Record merchant SMS consent before sending." }
  if (!selected.providerConfigured) return { phase: "blocked", sendEnabled: false, previewEnabled: true, reason: "The selected account is not ready. Ask an administrator to finish provider setup in Settings." }
  if (!input.previewed) return { phase: "validation", sendEnabled: false, previewEnabled: true, reason: "Preview the exact message before sending." }
  return { phase: "ready", sendEnabled: true, previewEnabled: true, reason: "Ready to send this exact text." }
}

export function SmsComposerPanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<ComposerContext>()
  const [accountId, setAccountId] = React.useState("")
  const [body, setBody] = React.useState("")
  const [evidence, setEvidence] = React.useState("")
  const [preview, setPreview] = React.useState<DirectPreview>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [notice, setNotice] = React.useState<string>()
  const sendKey = React.useRef(crypto.randomUUID())
  const consentKey = React.useRef(new Map<string, string>())

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const next = await requestJson<ComposerContext>(`/api/mca/sms/messages?dealId=${encodeURIComponent(dealId)}`)
      setPayload(next)
      setAccountId((current) => next.accounts.some((account) => account.id === current)
        ? current
        : next.accounts.find((account) => account.isDefault && account.providerConfigured)?.id
          ?? next.accounts.find((account) => account.providerConfigured)?.id
          ?? next.accounts[0]?.id
          ?? "")
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => { setPreview(undefined) }, [accountId, body])

  const consent: ConsentState = payload ? (payload.consent.state === "opted_in" || payload.consent.state === "opted_out" ? payload.consent.state : "unknown") : "loading"
  const gate = smsComposerGate({
    loading,
    recipient: payload?.recipient ?? null,
    accounts: payload?.accounts ?? [],
    selectedAccountId: accountId,
    consent: loading ? "loading" : consent,
    body,
    previewed: Boolean(preview) && preview?.body === body && preview.accountId === accountId,
  })

  async function recordConsent(state: "opted_in" | "opted_out") {
    if (!payload?.recipient || !evidence.trim()) return
    const scope = `consent-${state}`
    const existing = consentKey.current.get(scope) ?? crypto.randomUUID()
    consentKey.current.set(scope, existing)
    setBusy(scope)
    setError(undefined)
    setNotice(undefined)
    try {
      await requestJson("/api/mca/sms/consent", { method: "POST", body: JSON.stringify({ dealId, recipient: payload.recipient, state, evidence: evidence.trim(), idempotencyKey: existing }) })
      consentKey.current.delete(scope)
      setEvidence("")
      setNotice(state === "opted_in" ? "Merchant text consent recorded." : "Merchant text opt-out recorded.")
      await load()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  async function savePreview() {
    if (!payload?.recipient) return
    setBusy("preview")
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await requestJson<DirectPreview>("/api/mca/sms/messages", {
        method: "POST",
        body: JSON.stringify({ dealId, recipient: payload.recipient, body, senderAccountId: accountId, idempotencyKey: sendKey.current, preview: true }),
      })
      setPreview(next)
      if (!next.canSend && next.block) setError(next.block.message)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  async function send() {
    if (!payload?.recipient || !preview?.canSend) return
    setBusy("send")
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await requestJson<{ state: string; messageId?: string; errorMessage?: string }>("/api/mca/sms/messages", {
        method: "POST",
        body: JSON.stringify({ dealId, recipient: payload.recipient, body: preview.body, senderAccountId: preview.accountId, idempotencyKey: sendKey.current }),
      })
      if (result.state === "failed") {
        setError(result.errorMessage ?? "The provider rejected the text.")
      } else if (result.state === "unknown") {
        setError(result.errorMessage ?? "The provider outcome is unknown. Check provider activity before retrying.")
      } else {
        sendKey.current = crypto.randomUUID()
        setBody("")
        setPreview(undefined)
        setNotice("Text accepted. Delivery status updates in this thread.")
      }
      await load()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  if (loading) {
    return <Card>
      <CardContent className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />Loading SMS composer…
      </CardContent>
    </Card>
  }

  const selected = payload?.accounts.find((account) => account.id === accountId)

  return <Card>
    <CardHeader>
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-muted p-2"><MessageSquareText className="size-5" /></div>
        <div>
          <CardTitle>Text the merchant</CardTitle>
          <CardDescription>Send from an available account to the mobile number saved on this deal. Consent is checked again before every send.</CardDescription>
        </div>
      </div>
    </CardHeader>
    <CardContent className="space-y-5">
      {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
      {notice && <div role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</div>}

      {gate.phase === "empty" && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{gate.reason}</div>}

      {payload?.recipient && <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recipient</p>
          <p className="mt-1 font-medium">{payload.merchantName}</p>
          <p className="text-sm text-muted-foreground">{payload.recipient} · {payload.recipientMasked}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Consent</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant={consent === "opted_in" ? "default" : "outline"}>{consent.replace(/_/g, " ")}</Badge>
            {payload.consent.effectiveAt && <span className="text-xs text-muted-foreground">{payload.consent.effectiveAt}</span>}
          </div>
          <div className="mt-3 grid gap-2">
            <Label className="grid gap-1 text-xs">Consent evidence<Input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="How and when the merchant opted in" /></Label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={Boolean(busy) || !evidence.trim()} onClick={() => void recordConsent("opted_in")}>{busy === "consent-opted_in" && <Loader2 className="animate-spin" />}Record opt-in</Button>
              <Button size="sm" variant="outline" disabled={Boolean(busy) || !evidence.trim()} onClick={() => void recordConsent("opted_out")}>{busy === "consent-opted_out" && <Loader2 className="animate-spin" />}Record opt-out</Button>
            </div>
          </div>
        </div>
      </div>}

      {payload?.accounts.length ? <div className="grid gap-4">
        <Label className="grid gap-2">Assigned text account
          <select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">Choose an account</option>
            {payload.accounts.map((account) => <option key={account.id} value={account.id}>
              {account.label} · {providerLabel[account.provider] ?? account.provider} · {account.senderMasked}{account.providerConfigured ? "" : " · credentials absent"}{account.isDefault ? " · default" : ""}
            </option>)}
          </select>
        </Label>
        <Label className="grid gap-2">Message
          <Textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={1600} rows={5} placeholder="Exact text the merchant will receive" />
          <span className="text-xs font-normal text-muted-foreground">{body.trim().length}/1600</span>
        </Label>
        <p className="text-sm text-muted-foreground">{gate.reason}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!gate.previewEnabled || Boolean(busy)} onClick={() => void savePreview()}>{busy === "preview" && <Loader2 className="animate-spin" />}Preview exact text</Button>
          <Button disabled={!gate.sendEnabled || Boolean(busy)} onClick={() => void send()}>{busy === "send" && <Loader2 className="animate-spin" />}Send text</Button>
        </div>
      </div> : null}

      {preview && <div className="rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">Exact preview</p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{providerLabel[preview.provider] ?? preview.provider}</Badge>
            <Badge variant={preview.canSend ? "default" : "outline"}>{preview.canSend ? "ready" : "blocked"}</Badge>
          </div>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">To {preview.recipientMasked} from {preview.senderMasked}</p>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-sm">{preview.body}</pre>
        {preview.block && <p className="mt-2 text-sm text-amber-700">{preview.block.message}</p>}
      </div>}

      {selected && !selected.providerConfigured && <p className="text-sm text-amber-700">This account is marked credentials absent. Configure its workspace secret before sending.</p>}

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent thread</p>
        {!payload?.messages.length ? <p className="mt-2 text-sm text-muted-foreground">No texts have been sent on this deal yet.</p> : <div className="mt-2 space-y-2">
          {payload.messages.map((item) => <div key={item.id} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">{item.senderMasked} → {item.recipientMasked}</p>
              <Badge variant={item.state === "delivered" || item.state === "accepted" || item.state === "sent" ? "default" : "outline"}>{item.state}</Badge>
            </div>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-sm">{item.body}</pre>
            <p className="mt-1 text-xs text-muted-foreground">{item.createdAt}{item.errorMessage ? ` · ${item.errorMessage}` : ""}</p>
          </div>)}
        </div>}
      </div>
    </CardContent>
  </Card>
}
