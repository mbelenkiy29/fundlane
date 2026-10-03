"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { enrollmentContinuation, parseEnrollmentContinuation, type EnrollmentContinuation } from "@/lib/mca/auth-navigation"
import { requestJson } from "@/lib/mca/client"
import { EnrollmentAuth } from "./enrollment-auth"

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""
}
function errorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : ""
}

/** The invite token travels only in the URL fragment (`#t=`), never to a server until this page POSTs it. */
export function readInviteFragment(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("t")
  return token && /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : null
}

/** The emailed invite proves the purchase mailbox: set a password, or request a fresh link at a corrected email. */
export function EnrollmentSetPassword({ continuation, inviteId, token }: { continuation: EnrollmentContinuation; inviteId: string; token: string }) {
  const canonical = enrollmentContinuation(continuation)
  const [email, setEmail] = useState("")
  const [newEmail, setNewEmail] = useState("")
  const [password, setPassword] = useState("")
  const [changing, setChanging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const pending = useRef(false), errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending.current) return
    pending.current = true; setBusy(true); setError(""); setNotice("")
    try {
      const body = changing ? { challengeId: inviteId, token, newEmail } : { challengeId: inviteId, token, email, password }
      const result = await requestJson<{ destination?: string; emailChangeRequested?: true }>("/api/enrollment/invite", { method: "POST", body: JSON.stringify(body) })
      if (result.emailChangeRequested) { setNotice("We sent a new link to that address. This link no longer works. Wrong address? Use “Email me a new set-password link” below to cancel the change."); return }
      const next = parseEnrollmentContinuation(result.destination ?? null)
      if (!next || next.enrollmentId !== continuation.enrollmentId) throw new Error("Invalid continuation")
      window.location.assign(enrollmentContinuation(next))
    } catch (caught) {
      const code = errorCode(caught)
      setError(code === "enrollment_email_unavailable" ? errorMessage(caught) || "This email can't be used to set a new password. If you already set one, Login with it, or use Forgot password." : code === "weak_password" ? "Choose a stronger password with at least 12 characters." : code === "rate_limit_exceeded" ? "Too many attempts. Try again later." : code === "validation_failed" ? "Check the email and password, then try again." : "This link is invalid or expired. Request a new link or email code below, or Login.")
    } finally { setPassword(""); pending.current = false; setBusy(false) }
  }
  if (notice) return <section className="space-y-4"><p role="status">{notice}</p><EnrollmentAuth continuation={continuation} /></section>
  return <section className="space-y-4" aria-busy={busy}>
    <h2 className="text-lg font-semibold">Set your password</h2>
    <p className="text-sm text-muted-foreground">{changing ? "Enter the correct email. We'll send a new set-password link there; your purchase email stays the same until that link is used." : "Enter the email this link was sent to and choose a password."}</p>
    {error && <p ref={errorRef} tabIndex={-1} role="alert">{error}</p>}
    <form className="space-y-3" onSubmit={submit}>
      {changing
        ? <label className="grid gap-2" htmlFor="invite-new-email">Correct email<input className="rounded-md border p-2" id="invite-new-email" name="newEmail" type="email" autoComplete="email" maxLength={320} required disabled={busy} value={newEmail} onChange={e => setNewEmail(e.target.value)} /></label>
        : <>
          <label className="grid gap-2" htmlFor="invite-email">Email this link was sent to<input className="rounded-md border p-2" id="invite-email" name="email" type="email" autoComplete="email" maxLength={320} required disabled={busy} value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label className="grid gap-2" htmlFor="invite-password">Password<input className="rounded-md border p-2" id="invite-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={256} required disabled={busy} value={password} onChange={e => setPassword(e.target.value)} aria-describedby="invite-password-help" /></label>
          <p id="invite-password-help" className="text-sm text-muted-foreground">At least 12 characters. This link works once.</p>
        </>}
      <button className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" type="submit" disabled={busy}>{busy ? "Saving…" : changing ? "Send a new link to this email" : "Set password and continue"}</button>
    </form>
    <button className="underline" type="button" disabled={busy} onClick={() => { setChanging(value => !value); setError("") }}>{changing ? "Set a password instead" : "Use a different email"}</button>
    <p><Link className="underline" href={`/sign-in?next=${encodeURIComponent(canonical)}`}>Login with password</Link></p>
    <p><Link className="underline" href={`/forgot-password?next=${encodeURIComponent(canonical)}`}>Recover account</Link></p>
  </section>
}
