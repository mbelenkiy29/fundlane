"use client"

import { useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { requestJson } from "@/lib/mca/client"
import { TrialStartButton } from "./trial-start-button"

let pendingCheckout: Promise<{ enrollmentId: string; checkoutUrl: string }> | null = null

function browserCoordinator(): LockManager | null {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function" ? navigator.locks : null
}

const subscribeToBrowser = () => () => {}
const browserStatus = () => browserCoordinator() ? "supported" : "unsupported"
const serverBrowserStatus = () => "checking"

/** No account or tenant request precedes Stripe. The HttpOnly server binding owns retries. */
async function openCheckout() {
  const coordinator = browserCoordinator()
  if (!coordinator) throw new Error("Browser enrollment unavailable")
  if (!pendingCheckout) {
    const request = async () => {
      await requestJson("/api/enrollment/session", { method: "POST", body: "{}" })
      return requestJson<{ enrollmentId: string; checkoutUrl: string }>("/api/enrollment/start", { method: "POST", body: "{}" })
    }
    // First-cookie bootstrap requires cross-tab serialization. There is no
    // per-document fallback and no secret or identity in browser storage.
    pendingCheckout = Promise.resolve(coordinator.request("fundlane-enrollment-start", request)).finally(() => { pendingCheckout = null })
  }
  const result = await pendingCheckout
  if (!result) throw new Error("Checkout unavailable")
  const checkout = new URL(result.checkoutUrl)
  if (checkout.protocol !== "https:" || checkout.username || checkout.password) throw new Error("Checkout unavailable")
  window.location.assign(checkout.toString())
}

export function TrialCheckoutStart({ available }: { available: boolean }) {
  const browser = useSyncExternalStore(subscribeToBrowser, browserStatus, serverBrowserStatus)
  const [unavailable, setUnavailable] = useState(false)
  async function start() {
    if (!browserCoordinator()) { setUnavailable(true); return }
    await openCheckout()
  }
  if (!available) return <TrialStartButton available={false} />
  if (unavailable || browser !== "supported") return <div>
    <p className="fl-form-notice" role="status">{browser === "checking" && !unavailable ? "Checking secure trial enrollment in this browser…" : "Your browser cannot safely start a new trial. Use a compatible browser or get help."}{" "}<Link className="fl-inline-link" href="/help/set-up-your-company">Get help</Link>.{" "}<Link className="fl-inline-link" href="/sign-in">Login</Link> to your existing account.</p>
    <button className="fl-button" type="button" disabled>Start 14-day free trial</button>
  </div>
  return <TrialStartButton available onStart={start} />
}
