"use client"

import { useEffect, useId, useRef, useState } from "react"
import Link from "next/link"

export function TrialStartButton({ available, onStart, label = "Start 14-day free trial", className = "fl-button", compact = false, unavailableMessage = "Free trial enrollment is currently unavailable. Please try again later." }: {
  available: boolean
  onStart?: () => Promise<void>
  label?: string
  className?: string
  compact?: boolean
  unavailableMessage?: string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const inFlight = useRef(false)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const noticeId = useId()
  const canStart = available && Boolean(onStart)

  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  async function start() {
    if (!canStart || !onStart || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError("")
    try {
      await onStart()
    } catch {
      setError("We couldn't open secure Checkout. Please try again.")
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return <div className={compact ? "fl-trial-cta" : undefined} aria-busy={pending}>
    {!canStart && <p id={noticeId} className={compact ? "fl-sr-only" : "fl-form-notice"} role="status">
      {unavailableMessage}
      {!compact && <> <Link className="fl-inline-link" href="/sign-in">Login</Link> to your existing account.</>}
    </p>}
    {error && <p ref={errorRef} tabIndex={-1} className="fl-form-notice fl-form-error" role="alert">{error}</p>}
    <button className={className} type="button" disabled={!canStart || pending} aria-describedby={!canStart ? noticeId : undefined} title={!canStart ? unavailableMessage : undefined} onClick={start}>
      {pending ? "Opening secure Checkout…" : label}
    </button>
  </div>
}
