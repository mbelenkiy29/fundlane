"use client"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { monthlyPriceCents } from "@/lib/mca/billing-catalog"
import { formatBillingMoney, validSelectedSeats } from "@/lib/mca/billing-display"

export function SeatSelector({ value, onChange, minimum = 1 }: { value: number; onChange: (value: number) => void; minimum?: number }) {
  return <div className="space-y-3"><Label className="grid gap-2">Selected paid seats (including owner)<Input type="number" min={minimum} max={100000} step={1} required value={Number.isNaN(value) ? "" : value} onChange={event => onChange(event.target.valueAsNumber)}/></Label>
    <p className="text-xl font-semibold">{validSelectedSeats(value) ? `${formatBillingMoney(monthlyPriceCents(value))} / month` : "Select a whole number of seats"}</p>
    <p className="text-sm text-muted-foreground">$399/month includes the first user. Users 2–10: $79 each; 11–20: $69 each; 21+: $59 each. All prices USD.</p>
  </div>
}
