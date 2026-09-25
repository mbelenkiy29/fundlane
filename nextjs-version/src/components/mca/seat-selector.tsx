"use client"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { BILLING_CATALOG, monthlyPriceCents } from "@/lib/mca/billing-catalog"
import { formatBillingMoney, validSelectedSeats } from "@/lib/mca/billing-display"

export function SeatSelector({ value, onChange, minimum = 1 }: { value: number; onChange: (value: number) => void; minimum?: number }) {
  const [first, second, third] = BILLING_CATALOG.additionalSeats.tiers
  const money = (cents: number) => formatBillingMoney(cents).replace(/\.00$/, "")
  return <div className="space-y-3"><Label className="grid gap-2">Selected paid seats (including owner)<Input type="number" min={minimum} max={100000} step={1} required value={Number.isNaN(value) ? "" : value} onChange={event => onChange(event.target.valueAsNumber)}/></Label>
    <p className="text-xl font-semibold">{validSelectedSeats(value) ? `${formatBillingMoney(monthlyPriceCents(value))} / month` : "Select a whole number of seats"}</p>
    <p className="text-sm text-muted-foreground">{money(BILLING_CATALOG.base.unitAmountCents)}/month includes the first user. Users 2–{first.upTo + 1}: {money(first.unitAmountCents)} each; {first.upTo + 2}–{second.upTo + 1}: {money(second.unitAmountCents)} each; {second.upTo + 2}+: {money(third.unitAmountCents)} each. All prices USD.</p>
  </div>
}
