"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { enrollmentContinuation, parseEnrollmentContinuation, type EnrollmentContinuation } from "@/lib/mca/auth-navigation"
import { requestJson } from "@/lib/mca/client"

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""
}

/** The emailed invite proves the Checkout mailbox: set a password, or correct the email and receive a fresh invite. */
export function EnrollmentSetPassword({ continuation, invite }: { continuation: EnrollmentContinuation; invite: { challengeId: string; email: string } }) {
  const canonical = enrollmentContinuation(continuation)
  const [email, setEmail] = useState(invite.email)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const pending = useRef(false), errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  const edited = email.trim().toLowerCase() !== invite.email.toLowerCase()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending.current) return
    pending.current = true; setBusy(true); setError(""); setNotice("")
    try {
      const result = await requestJson<{ destination?: string; emailChanged?: true }>("/api/enrollment/invite", { method: "POST", body: JSON.stringify({ challengeId: invite.challengeId, email, ...(edited ? {} : { password }) }) })
      if (result.emailChanged) { setNotice("We'll send a new link to that address shortly. It expires 24 hours after it is sent."); return }
      const next = parseEnrollmentContinuation(result.destination ?? null)
      if (!next || next.enrollmentId !== continuation.enrollmentId) throw new Error("Invalid continuation")
      window.location.assign(enrollmentContinuation(next))
    } catch (caught) {
      const code = errorCode(caught)
      setError(code === "enrollment_account_exists" ? "An account already uses this email. Login with your password to continue." : code === "enrollment_email_unavailable" ? "That email already has an account. Login with it, or use another email." : code === "weak_password" || code === "validation_failed" ? "Choose a stronger password with at least 12 characters." : "This link is invalid or expired. Reload this page to request a new email code, or Login.")
    } finally { setPassword(""); pending.current = false; setBusy(false) }
  }
  return <section className="space-y-4" aria-busy={busy}>
    <h2 className="text-lg font-semibold">Set your password</h2>
    <p className="text-sm text-muted-foreground">Confirm the email for your Fundlane account. If it is wrong, correct it and we&apos;ll send a new link to the corrected address.</p>
    {error && <p ref={errorRef} tabIndex={-1} role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!notice && <form className="space-y-3" onSubmit={submit}>
      <label className="grid gap-2" htmlFor="invite-email">Account email<input className="rounded-md border p-2" id="invite-email" name="email" type="email" autoComplete="email" maxLength={320} required disabled={busy} value={email} onChange={e => setEmail(e.target.value)} /></label>
      {!edited && <label className="grid gap-2" htmlFor="invite-password">Password<input className="rounded-md border p-2" id="invite-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required disabled={busy} value={password} onChange={e => setPassword(e.target.value)} aria-describedby="invite-password-help" /></label>}
      {!edited && <p id="invite-password-help" className="text-sm text-muted-foreground">At least 12 characters. This link works once.</p>}
      <button className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" type="submit" disabled={busy}>{busy ? "Saving…" : edited ? "Send a new link to this email" : "Set password and continue"}</button>
    </form>}
    <p><Link className="underline" href={`/sign-in?next=${encodeURIComponent(canonical)}`}>Login with password</Link></p>
    <p><Link className="underline" href={`/forgot-password?next=${encodeURIComponent(canonical)}`}>Recover account</Link></p>
  </section>
}
