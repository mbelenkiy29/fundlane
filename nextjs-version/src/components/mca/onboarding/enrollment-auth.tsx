"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { enrollmentContinuation, parseEnrollmentContinuation, type EnrollmentContinuation } from "@/lib/mca/auth-navigation"
import { requestJson } from "@/lib/mca/client"
import { enrollmentCodeError, normalizeEnrollmentCode } from "@/lib/mca/onboarding/enrollment-code"

/** Enrollment-issued email authentication is distinct from ordinary magic-link login. */
export function EnrollmentAuth({ continuation }: { continuation: EnrollmentContinuation }) {
  const canonical = enrollmentContinuation(continuation)
  const [email, setEmail] = useState("")
  const [challenge, setChallenge] = useState<{ id: string; email: string } | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const pending = useRef(false), codeRef = useRef<HTMLInputElement>(null), errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (challenge) codeRef.current?.focus() }, [challenge])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  async function run(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(""); setNotice("")
    try { await action() } catch { setError("We couldn't verify this request. Use the email entered at Checkout, or request a new code and try again.") }
    finally { pending.current = false; setBusy(false) }
  }
  async function send() {
    await run(async () => {
      const result = await requestJson<{ success: true; challengeId: string }>("/api/enrollment/auth", { method: "POST", body: JSON.stringify({ ...continuation, email }) })
      setChallenge({ id: result.challengeId, email }); setCode("")
      setNotice("If this email can continue the purchase, we've sent a verification code and link. Codes expire after 15 minutes.")
    })
  }
  async function resend() {
    await run(async () => {
      // Account-neutral: a fresh link goes only to the purchase email on file, and cancels a pending email change.
      await requestJson("/api/enrollment/resend", { method: "POST", body: JSON.stringify({ ...continuation, email }) })
      setNotice("If this purchase still needs a password, we've emailed a new set-password link to the purchase email.")
    })
  }
  async function verify(event: FormEvent) {
    event.preventDefault()
    const invalid = challenge ? enrollmentCodeError(code) : "Your code request expired. Request a new code and try again."
    if (!challenge || invalid) { setError(invalid!); setNotice(""); return }
    await run(async () => {
      const result = await requestJson<{ destination: string }>("/api/enrollment/verify", { method: "POST", body: JSON.stringify({ challengeId: challenge.id, email: challenge.email, token: normalizeEnrollmentCode(code) }) })
      const next = parseEnrollmentContinuation(result.destination)
      if (!next || next.enrollmentId !== continuation.enrollmentId) throw new Error("Invalid continuation")
      window.location.assign(enrollmentContinuation(next))
    })
  }
  async function google() {
    await run(async () => {
      const result = await requestJson<{ url: string }>("/api/auth/google", { method: "POST", body: JSON.stringify({ next: canonical }) })
      window.location.assign(result.url)
    })
  }
  return <section className="space-y-4" aria-busy={busy}>
    <h2 className="text-lg font-semibold">Verify your email</h2>
    <p className="text-sm text-muted-foreground">Use the email entered at Checkout. An existing account can also Login with its password or Google. No company form is required.</p>
    {error && <p ref={errorRef} tabIndex={-1} role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {challenge ? <form className="space-y-3" noValidate onSubmit={verify}>
      <label className="grid gap-2" htmlFor="enrollment-code">Email verification code<input className="rounded-md border p-2" id="enrollment-code" ref={codeRef} name="token" inputMode="numeric" autoComplete="one-time-code" maxLength={20} disabled={busy} value={code} onChange={e => setCode(e.target.value)} /></label>
      <button className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" type="submit" disabled={busy}>{busy ? "Verifying…" : "Verify and continue"}</button>
      <button type="button" className="underline" disabled={busy} onClick={() => void send()}>Request a new code</button>{" "}
      <button type="button" className="underline" disabled={busy} onClick={() => { setChallenge(null); setCode(""); setError(""); setNotice("") }}>Change email</button>
    </form> : <form className="space-y-3" onSubmit={e => { e.preventDefault(); void send() }}>
      <label className="grid gap-2" htmlFor="enrollment-email">Checkout email<input className="rounded-md border p-2" id="enrollment-email" name="email" type="email" autoComplete="email" required disabled={busy} value={email} onChange={e => setEmail(e.target.value)} /></label>
      <button className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" type="submit" disabled={busy}>{busy ? "Sending verification…" : "Send verification code"}</button>{" "}
      <button type="button" className="underline" disabled={busy || !email} onClick={() => void resend()}>Email me a new set-password link</button>
    </form>}
    <button className="inline-flex items-center justify-center rounded-md border px-4 py-3 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" type="button" disabled={busy} onClick={() => void google()}>Continue with Google</button>
    <p><Link className="underline" href={`/sign-in?next=${encodeURIComponent(canonical)}`}>Login with password</Link></p>
    <p><Link className="underline" href={`/forgot-password?next=${encodeURIComponent(canonical)}`}>Recover account</Link></p>
  </section>
}
