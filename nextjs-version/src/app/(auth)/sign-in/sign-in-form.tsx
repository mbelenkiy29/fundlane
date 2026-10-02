"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import Link from "next/link"
import { ArrowUpRight, LoaderCircle } from "lucide-react"
import { useSignInFlow } from "@/components/mca/auth/use-sign-in-flow"
import { requestJson } from "@/lib/mca/client"
import {
  authErrorMessage,
  currentAuthContinuation,
} from "@/lib/mca/auth-navigation"

export function SignInForm({ magicLinkEnabled = false, showMigratedAccountNotice = true }: {
  magicLinkEnabled?: boolean
  inviteOnly?: boolean
  showMigratedAccountNotice?: boolean
}) {
  const flow = useSignInFlow()
  const [email, setEmail] = useState("")
  const [stage, setStage] = useState<"email" | "password">("email")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [googleBusy, setGoogleBusy] = useState(false)
  const [googleError, setGoogleError] = useState("")
  const [magicBusy, setMagicBusy] = useState(false)
  const [magicError, setMagicError] = useState("")
  const [magicSent, setMagicSent] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const loading = flow.busy
  const busy = loading || googleBusy || magicBusy
  const error = flow.error || googleError || magicError

  useEffect(() => {
    if (stage === "password") passwordRef.current?.focus()
    else emailRef.current?.focus()
  }, [stage])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  async function sendMagicLink() {
    setMagicBusy(true)
    setMagicError("")
    setMagicSent(false)
    try {
      await requestJson("/api/auth/magic-link", {
        method: "POST",
        body: JSON.stringify({ email, next: currentAuthContinuation() }),
      })
      setMagicSent(true)
    } catch (caught) {
      setMagicError(authErrorMessage(caught))
    } finally {
      setMagicBusy(false)
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setGoogleError("")
    if (stage === "email") {
      setStage("password")
      return
    }
    await flow.password(email, password)
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setGoogleError("")
    if (flow.mfaRequired) await flow.verifyTotp(code)
    else await flow.verify(code)
  }

  async function continueWithGoogle() {
    setGoogleBusy(true)
    setGoogleError("")
    try {
      const result = await requestJson<{ url: string }>("/api/auth/google", {
        method: "POST",
        body: JSON.stringify({ next: currentAuthContinuation() }),
      })
      window.location.assign(result.url)
    } catch (caught) {
      setGoogleError(authErrorMessage(caught))
      setGoogleBusy(false)
    }
  }

  if (flow.mfaRequired) {
    return (
      <>
        <h2 id="sign-in-title">Two-factor authentication</h2>
        <p>Enter an authenticator or single-use recovery code to finish signing in.</p>
        <form className="fl-form" onSubmit={submitCode} aria-busy={loading}>
          {error && (
            <p ref={errorRef} tabIndex={-1} className="fl-form-notice fl-form-error" role="alert">
              {error}
            </p>
          )}
          <div>
            <label htmlFor="sign-in-totp">Authenticator or recovery code</label>
            <input
              id="sign-in-totp"
              name="code"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoFocus
              disabled={loading}
            />
          </div>
          <button className="fl-button" type="submit" disabled={loading}>
            {loading ? "Verifying…" : "Verify and continue"}
            {loading ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUpRight size={16} aria-hidden="true" />
            )}
          </button>
        </form>
      </>
    )
  }

  if (flow.codeSent) {
    return (
      <>
        <h2 id="sign-in-title">Verify your email</h2>
        <p>Enter the email verification code to finish verifying your account.</p>
        <form className="fl-form" onSubmit={submitCode} aria-busy={loading}>
          {error && (
            <p ref={errorRef} tabIndex={-1} className="fl-form-notice fl-form-error" role="alert">
              {error}
            </p>
          )}
          <div>
            <label htmlFor="sign-in-code">Verification code</label>
            <input
              id="sign-in-code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoFocus
              disabled={loading}
            />
          </div>
          <button className="fl-button" type="submit" disabled={loading}>
            {loading ? "Verifying…" : "Verify and continue"}
            {loading ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUpRight size={16} aria-hidden="true" />
            )}
          </button>
        </form>
      </>
    )
  }

  return (
    <>
      <h2 id="sign-in-title">Login</h2>
      <p>Use your work email or continue with Google.</p>
      <form className="fl-form" onSubmit={submitPassword} aria-busy={busy}>
        <button
          className="fl-button fl-button-secondary"
          type="button"
          disabled={loading || googleBusy || magicBusy}
          onClick={continueWithGoogle}
        >
          {googleBusy ? "Connecting to Google…" : "Continue with Google"}
        </button>
        <p className="fl-sign-in-divider" aria-hidden="true">
          or
        </p>
        {error && (
          <p ref={errorRef} tabIndex={-1} className="fl-form-notice fl-form-error" role="alert">
            {error}
          </p>
        )}
        <div>
          <label htmlFor="sign-in-email">Work email</label>
          <input
            id="sign-in-email"
            ref={emailRef}
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => { setEmail(event.target.value); setMagicSent(false) }}
            required
            autoFocus
            disabled={loading || googleBusy || magicBusy}
            readOnly={stage === "password"}
          />
          {stage === "password" && <button className="fl-inline-link" type="button" disabled={busy} onClick={() => {
            setStage("email")
            setPassword("")
            setMagicSent(false)
            setGoogleError("")
            setMagicError("")
          }}>Change email</button>}
        </div>
        {stage === "password" && <div>
          <div className="fl-sign-in-label-row">
            <label htmlFor="sign-in-password">Password</label>
            <Link href="/forgot-password" className="fl-inline-link">
              Forgot password?
            </Link>
          </div>
          <input
            id="sign-in-password"
            ref={passwordRef}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoFocus
            disabled={loading || googleBusy || magicBusy}
          />
        </div>}
        <button className="fl-button" type="submit" disabled={loading || googleBusy || magicBusy}>
          {loading ? "Signing in…" : stage === "email" ? "Next" : "Login"}
          {loading ? (
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
          ) : (
            <ArrowUpRight size={16} aria-hidden="true" />
          )}
        </button>
        {stage === "password" && magicLinkEnabled && (
          <>
            <button className="fl-button fl-button-secondary" type="button" disabled={loading || googleBusy || magicBusy || !email} onClick={sendMagicLink}>
              {magicBusy ? "Sending link…" : "Email me a sign-in link"}
            </button>
            {magicSent && <p className="fl-form-notice" role="status">If an account exists, we&apos;ve sent a link.</p>}
          </>
        )}
        {stage === "password" && <button
          className="fl-button fl-button-secondary"
          type="button"
          disabled={loading || googleBusy || magicBusy || !email}
          onClick={() => {
            setGoogleError("")
            void flow.sendCode(email)
          }}
        >
          Resend email verification
        </button>}
        {showMigratedAccountNotice && <p className="fl-form-privacy">
          Existing users:{" "}
          <Link href="/forgot-password" className="fl-inline-link">
            set a new password
          </Link>{" "}
          to activate your migrated account.
        </p>}
        <p className="fl-form-privacy">
          New team members join through an invitation.
        </p>
      </form>
    </>
  )
}
