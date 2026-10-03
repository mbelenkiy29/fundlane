"use client"

import { useEffect, useRef, useState } from "react"
import { enrollmentContinuation, type EnrollmentContinuation } from "@/lib/mca/auth-navigation"
import { BILLING_CATALOG } from "@/lib/mca/billing-catalog"
import { formatBillingMoney } from "@/lib/mca/billing-display"
import { BillingDate } from "@/components/mca/billing-date"
import { requestJson } from "@/lib/mca/client"
import type { EnrollmentPublicStatus } from "@/lib/mca/onboarding/claim"
import { EnrollmentAuth } from "./enrollment-auth"
import { EnrollmentSetPassword, readInviteFragment } from "./enrollment-set-password"

const allowedDestinations = new Set(["/dashboard", "/settings/business", "/settings/billing"])
const pollLimit = 12, pollDelay = 5000
const firstUserMonthlyPrice = formatBillingMoney(BILLING_CATALOG.base.unitAmountCents, BILLING_CATALOG.currency).replace(/\.00$/, "")
function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""
}

/** Status is observational; workspace claim and portal creation require explicit actions. */
export function EnrollmentCompletion({ continuation, initialStatus, supportEmail, inviteId }: {
  continuation: EnrollmentContinuation
  initialStatus?: EnrollmentPublicStatus
  supportEmail?: string | null
  inviteId?: string
}) {
  const canonical = enrollmentContinuation(continuation)
  const [status, setStatus] = useState(initialStatus)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [wrongAccount, setWrongAccount] = useState(false)
  const [authenticationNeeded, setAuthenticationNeeded] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [refresh, setRefresh] = useState(0)
  // undefined until mounted; null when no usable fragment token was present.
  const [inviteToken, setInviteToken] = useState<string | null>()
  const actionPending = useRef(false), errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  useEffect(() => {
    if (!inviteId) return
    // The fragment never reaches a server; read it once and drop it from the address bar and history.
    const token = readInviteFragment(window.location.hash)
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
    setInviteToken(current => current ?? token)
  }, [inviteId])

  useEffect(() => {
    let cancelled = false, attempts = 0, timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    async function check() {
      setChecking(true)
      try {
        const next = await requestJson<EnrollmentPublicStatus>(`/api/enrollment/status?${canonical.split("?")[1]}`, { signal: controller.signal })
        if (cancelled) return
        setStatus(next); setError(""); setStopped(false)
        if (next.nextAction === "wait") {
          if (++attempts < pollLimit) timer = setTimeout(() => void check(), pollDelay)
          else setStopped(true)
        }
      } catch (caught) {
        if (cancelled) return
        setStopped(true)
        const code = errorCode(caught)
        setError(code === "enrollment_link_superseded" ? "This purchase link has been replaced. Open the latest link from your email or contact support." : code === "enrollment_disabled" ? "Purchase recovery is temporarily unavailable. Please try again later or contact support." : "Purchase confirmation could not be loaded. Please retry; your trial clock will not restart.")
      } finally { if (!cancelled) setChecking(false) }
    }
    void check()
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer) }
  }, [canonical, refresh])

  async function run(action: "claim" | "billing" | "sign-out") {
    if (actionPending.current) return
    actionPending.current = true; setBusy(true); setError("")
    try {
      if (action === "sign-out") {
        await requestJson("/api/auth/sign-out", { method: "POST", body: "{}" })
        window.location.assign(canonical)
      } else if (action === "billing") {
        const result = await requestJson<{ url: string }>("/api/enrollment/billing", { method: "POST", body: JSON.stringify(continuation) })
        const url = new URL(result.url)
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid portal")
        window.location.assign(url.toString())
      } else {
        const result = await requestJson<{ destination: string }>("/api/enrollment/claim", { method: "POST", body: JSON.stringify(continuation) })
        if (!allowedDestinations.has(result.destination)) throw new Error("Invalid destination")
        window.location.assign(result.destination)
      }
    } catch (caught) {
      const code = errorCode(caught)
      if (code === "totp_required" || code === "totp_enrollment_required") {
        window.location.assign(`/account-security?${code === "totp_required" ? "challenge" : "required"}=1&next=${encodeURIComponent(canonical)}`)
      } else if (code === "authentication_required") {
        setAuthenticationNeeded(true); setError("Verify the purchase email or Login to the correct account before continuing.")
      } else if (code === "enrollment_identity_mismatch") {
        setWrongAccount(true); setError("This purchase belongs to a different account. Sign out and use the email entered at Checkout.")
      } else if (code === "enrollment_existing_company" || code === "trial_not_eligible" || code === "enrollment_already_claimed") {
        setError("This purchase needs account or billing review. Existing company access remains available through Login; contact support before starting another purchase.")
      } else if (code === "enrollment_link_superseded") {
        setError("This purchase link has been replaced. Open your latest email link or contact support.")
      } else {
        setError("We couldn't complete this request. Retry confirmation or contact support. No new purchase has been started.")
      }
    } finally { actionPending.current = false; setBusy(false) }
  }
  const needsAuth = authenticationNeeded || status?.nextAction === "authenticate"
  const validTrialDate = status?.trialEndsAt && Number.isFinite(Date.parse(status.trialEndsAt)) ? status.trialEndsAt : null
  return <div className="space-y-5" aria-busy={busy || checking}>
    {error && <p ref={errorRef} tabIndex={-1} className="text-destructive" role="alert">{error}</p>}
    {!status && <p role="status">{checking ? "Checking your purchase…" : "Retry purchase confirmation to continue."}</p>}
    {status?.state === "pending" && <p role="status">We are confirming your Checkout. {stopped ? "Confirmation is taking longer than expected. Retry below or contact support." : "You can safely wait here."} Your original trial clock will not restart.</p>}
    {status?.state === "ready" && <p>Your trial is confirmed. Finish secure access to enter your CRM.</p>}
    {status?.state === "claimed" && <p>Your workspace is ready. Continue to your CRM or manage billing.</p>}
    {status?.state === "recovery_required" && <p role="status">This purchase needs billing or account review. Manage or cancel billing if available, or contact support. Do not start another purchase.</p>}
    {status?.state === "unavailable" && <p>Use the correct account to recover this purchase. The link alone does not grant access.</p>}
    {validTrialDate && <p>Your original trial ends <BillingDate value={validTrialDate} timeZone={status?.timeZone} />. The subscription automatically converts at the base monthly first-user price of {firstUserMonthlyPrice}/month {BILLING_CATALOG.currency.toUpperCase()} unless canceled before then; applicable Checkout discounts and tax follow your Checkout terms.</p>}
    {needsAuth && (inviteId ? (inviteToken ? <EnrollmentSetPassword continuation={continuation} inviteId={inviteId} token={inviteToken} /> : inviteToken === null ? <EnrollmentAuth continuation={continuation} /> : null) : <EnrollmentAuth continuation={continuation} />)}
    {(wrongAccount || needsAuth) && <button className="inline-flex items-center justify-center rounded-md border px-4 py-3 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" type="button" disabled={busy} onClick={() => void run("sign-out")}>Sign out and use another account</button>}
    {status?.nextAction === "claim" && !needsAuth && !wrongAccount && <button className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" type="button" disabled={busy} onClick={() => run("claim")}>{busy ? "Finishing secure access…" : "Enter your CRM"}</button>}
    {status?.nextAction === "continue" && status.destination && allowedDestinations.has(status.destination) && <button className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" type="button" disabled={busy} onClick={() => run("claim")}>Continue to your workspace</button>}
    <div className="flex flex-wrap gap-4">
      <button className="underline" type="button" disabled={busy || checking} onClick={() => { setError(""); setStopped(false); setRefresh(value => value + 1) }}>{checking ? "Checking confirmation…" : "Retry confirmation"}</button>
      {status && status.state !== "unavailable" && <button className="underline" type="button" disabled={busy} onClick={() => run("billing")}>Manage or cancel billing</button>}
    </div>
    <p className="text-sm text-muted-foreground">No additional company, seats, or setup form is required to enter the CRM. Business details and getting started are optional inside your workspace.</p>
    <p className="text-sm">Need help? {supportEmail ? <a className="underline" href={`mailto:${supportEmail}`}>Contact support</a> : "Contact your Fundlane support team."} Keep this page or use your purchase email link; do not start another trial while confirmation is pending.</p>
  </div>
}
