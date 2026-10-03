"use client"
import { useSyncExternalStore } from "react"
import { billingTimeZone, formatBillingDate } from "@/lib/mca/billing-display"

const subscribeNothing = () => () => {}
/**
 * A billing timestamp in the company's stored time zone, else the viewer's browser zone. With no stored zone the
 * server cannot know the viewer's, so server render and hydration use UTC and the client re-renders in its own zone.
 */
export function BillingDate({ value, timeZone }: { value:string; timeZone?:string|null }) {
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false)
  const zone = billingTimeZone(timeZone) ?? (hydrated ? undefined : "UTC")
  return <time dateTime={value}>{formatBillingDate(value, zone)}</time>
}
