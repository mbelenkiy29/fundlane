"use client"

import { requestJson } from "@/lib/mca/client"
import { TrialStartButton } from "./trial-start-button"

let pendingCheckout: Promise<{ enrollmentId: string; checkoutUrl: string }> | null = null

/** No account or tenant request precedes Stripe. The HttpOnly server binding owns retries. */
async function openCheckout() {
  if (!pendingCheckout) {
    const request = async () => {
      await requestJson("/api/enrollment/session", { method: "POST", body: "{}" })
      return requestJson<{ enrollmentId: string; checkoutUrl: string }>("/api/enrollment/start", { method: "POST", body: "{}" })
    }
    // Serialize first-cookie bootstrap across tabs where Web Locks is supported.
    // No secret or identity is copied into browser storage.
    pendingCheckout = Promise.resolve(typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request("fundlane-enrollment-start", request)
      : request()).finally(() => { pendingCheckout = null })
  }
  const result = await pendingCheckout
  if (!result) throw new Error("Checkout unavailable")
  const checkout = new URL(result.checkoutUrl)
  if (checkout.protocol !== "https:" || checkout.username || checkout.password) throw new Error("Checkout unavailable")
  window.location.assign(checkout.toString())
}

export function TrialCheckoutStart({ available }: { available: boolean }) {
  return <TrialStartButton available={available} onStart={openCheckout} />
}
