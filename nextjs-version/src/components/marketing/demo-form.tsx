"use client"

import { useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { ArrowUpRight, CheckCircle2 } from "lucide-react"
import { demoSchema, TEAM_SIZES } from "@/lib/marketing/demo-schema"
import { DemoFallback } from "./demo-fallback"

type Errors = Record<string, string[] | undefined>

export function DemoForm({
  enabled,
  privacyUrl,
  supportEmail,
  requestTimeoutMs,
}: {
  enabled: boolean
  privacyUrl: string | null
  supportEmail: string | null
  requestTimeoutMs: number
}) {
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState("")
  const [fields, setFields] = useState<Errors>({})
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(
    null
  )
  const submitting = useRef(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!enabled || submitting.current) return
    const form = event.currentTarget
    const data = new FormData(form)
    const values = Object.fromEntries(data.entries())
    const fingerprint = JSON.stringify(values)
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, requestId: crypto.randomUUID() }
    const payload = demoSchema.safeParse({
      ...values,
      requestId: attempt.current.requestId,
    })
    setError("")
    setFields({})
    if (!payload.success) {
      const errors = payload.error.flatten().fieldErrors
      setFields(errors)
      form
        .querySelector<HTMLElement>(`[name="${Object.keys(errors)[0]}"]`)
        ?.focus()
      return
    }
    submitting.current = true
    setBusy(true)
    try {
      const response = await fetch("/api/marketing/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.data),
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      const result = await response.json()
      if (!response.ok || result.accepted !== true) {
        setFields(result.fields ?? {})
        setError(
          result.error || "We couldn’t confirm your request. Please try again."
        )
        return
      }
      setAccepted(true)
    } catch {
      setError(
        "We couldn’t confirm your request. Your details are still here—please try again."
      )
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  if (accepted)
    return (
      <div className="fl-success" role="status">
        <CheckCircle2 size={38} strokeWidth={1.5} />
        <h3>You’re on our list.</h3>
        <p>
          Your demo request has been received. We’ll follow up at the email
          address you provided to arrange a walkthrough.
        </p>
        <Link href="/" className="fl-text-link">
          Back to Fundlane
          <ArrowUpRight size={16} />
        </Link>
      </div>
    )

  return (
    <form className="fl-form" onSubmit={submit} noValidate aria-busy={busy}>
      {!enabled && <DemoFallback supportEmail={supportEmail} />}
      <noscript>
        <p className="fl-form-notice">
          Enable JavaScript to send your demo request.
          {supportEmail ? <> You can also email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</> : " You can still explore the product and workflow on our homepage."}
        </p>
        <style>{`.fl-form button[type="submit"]{display:none}`}</style>
      </noscript>
      <div>
        <label htmlFor="demo-name">Your name</label>
        <input
          id="demo-name"
          name="name"
          autoComplete="name"
          placeholder="Alex Morgan"
          maxLength={100}
          required
          disabled={!enabled || busy}
          aria-invalid={!!fields.name}
          aria-describedby={fields.name ? "demo-name-error" : undefined}
        />
        {fields.name && (
          <p id="demo-name-error" className="fl-field-error">
            {fields.name[0]}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="demo-email">Work email</label>
        <input
          id="demo-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="alex@yourbrokerage.com"
          maxLength={254}
          required
          disabled={!enabled || busy}
          aria-invalid={!!fields.email}
          aria-describedby={fields.email ? "demo-email-error" : undefined}
        />
        {fields.email && (
          <p id="demo-email-error" className="fl-field-error">
            {fields.email[0]}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="demo-brokerage">Brokerage name</label>
        <input
          id="demo-brokerage"
          name="brokerage"
          autoComplete="organization"
          placeholder="Your brokerage"
          maxLength={150}
          required
          disabled={!enabled || busy}
          aria-invalid={!!fields.brokerage}
          aria-describedby={
            fields.brokerage ? "demo-brokerage-error" : undefined
          }
        />
        {fields.brokerage && (
          <p id="demo-brokerage-error" className="fl-field-error">
            {fields.brokerage[0]}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="demo-team">Team size</label>
        <select
          id="demo-team"
          name="teamSize"
          defaultValue=""
          required
          disabled={!enabled || busy}
          aria-invalid={!!fields.teamSize}
          aria-describedby={fields.teamSize ? "demo-team-error" : undefined}
        >
          <option value="" disabled>
            Select team size
          </option>
          {TEAM_SIZES.map((size) => (
            <option key={size} value={size}>
              {size === "1" ? "Just me" : `${size} people`}
            </option>
          ))}
        </select>
        {fields.teamSize && (
          <p id="demo-team-error" className="fl-field-error">
            {fields.teamSize[0]}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="demo-message">
          What would you like to improve? <span>(optional)</span>
        </label>
        <textarea
          id="demo-message"
          name="message"
          placeholder="Tell us about your workflow or what’s slowing your team down."
          maxLength={2000}
          rows={3}
          disabled={!enabled || busy}
          aria-invalid={!!fields.message}
          aria-describedby={fields.message ? "demo-message-error" : undefined}
        />
        {fields.message && (
          <p id="demo-message-error" className="fl-field-error">
            {fields.message[0]}
          </p>
        )}
      </div>
      <div className="fl-honeypot" aria-hidden="true">
        <label htmlFor="demo-website">Leave this field empty</label>
        <input
          id="demo-website"
          name="website"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>
      {error && (
        <p className="fl-form-notice fl-form-error" role="alert">
          {error} {supportEmail && <>If this continues, email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</>}
        </p>
      )}
      {privacyUrl && (
        <p className="fl-form-privacy">
          By requesting a demo, you agree that Fundlane may contact you about
          your request. Read our <a href={privacyUrl}>privacy notice</a>.
        </p>
      )}
      <button className="fl-button" type="submit" disabled={!enabled || busy}>
        {busy ? "Sending your request…" : "Request a demo"}
        <ArrowUpRight size={16} aria-hidden="true" />
      </button>
    </form>
  )
}
