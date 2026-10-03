"use client"

import Link from "next/link"
import { BillingDate } from "@/components/mca/billing-date"

/**
 * Dashboard trial banner. The trial end is shown in the workspace's stored time zone (validated on the server),
 * else the viewer's browser zone, always with the zone named, via the same BillingDate as Plans & Billing.
 */
export function TrialBanner({ trialEndsAt, timeZone }: { trialEndsAt?: string | null; timeZone?: string | null }) {
  if (!trialEndsAt || !Number.isFinite(Date.parse(trialEndsAt))) return null
  return <p className="text-sm">Your trial ends <BillingDate value={trialEndsAt} timeZone={timeZone} />. <Link className="underline" href="/settings/billing">Manage or cancel billing</Link>.</p>
}
