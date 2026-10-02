"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"

export function TrialStartButton({ available, onStart }: {
  available: boolean
  onStart?: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const inFlight = useRef(false)
  const errorRef = useRef<HTMLParagraphElement>(null)
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

  return <div aria-busy={pending}>
    {!canStart && <p className="fl-form-notice" role="status">
      Free trial enrollment is currently unavailable. Please try again later.{" "}
      <Link className="fl-inline-link" href="/sign-in">Login</Link> to your existing account.
    </p>}
    {error && <p ref={errorRef} tabIndex={-1} className="fl-form-notice fl-form-error" role="alert">{error}</p>}
    <button className="fl-button" type="button" disabled={!canStart || pending} onClick={start}>
      {pending ? "Opening secure Checkout…" : "Start 14-day free trial"}
    </button>
  </div>
}
