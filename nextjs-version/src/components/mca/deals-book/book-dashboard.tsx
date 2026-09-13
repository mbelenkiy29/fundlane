"use client"

import { AlertTriangle, CheckCircle2, RefreshCcw } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { formatCents } from "@/components/mca/accounting/format"
import type { BookDashboard, BookWindow } from "@/lib/mca/deals/book-contracts"

function WindowToggle({ value, onChange, label }: { value: BookWindow; onChange: (value: BookWindow) => void; label: string }) {
  return (
    <ToggleGroup type="single" size="sm" variant="outline" value={value} onValueChange={(next) => next && onChange(next as BookWindow)} aria-label={label}>
      <ToggleGroupItem value="today">Today</ToggleGroupItem>
      <ToggleGroupItem value="week">This week</ToggleGroupItem>
      <ToggleGroupItem value="month">This month</ToggleGroupItem>
    </ToggleGroup>
  )
}

export function BookDashboardCards({ dashboard, onMissedWindow, onCompletedWindow, onRenewals }: {
  dashboard: BookDashboard
  onMissedWindow: (window: BookWindow) => void
  onCompletedWindow: (window: BookWindow) => void
  onRenewals: () => void
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><AlertTriangle className="size-3.5" />Missed payments</p>
              <p className="mt-1 text-2xl font-semibold">{dashboard.missed.count}</p>
              <p className="text-xs text-muted-foreground">{formatCents(dashboard.missed.amountCents)} expected, no receipt</p>
            </div>
          </div>
          <WindowToggle value={dashboard.missed.window} onChange={onMissedWindow} label="Missed payments window" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-5">
          <div>
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-3.5" />Completed payments</p>
            <p className="mt-1 text-2xl font-semibold">{dashboard.completed.count}</p>
            <p className="text-xs text-muted-foreground">{formatCents(dashboard.completed.amountCents)} recorded receipts</p>
          </div>
          <WindowToggle value={dashboard.completed.window} onChange={onCompletedWindow} label="Completed payments window" />
        </CardContent>
      </Card>
      <Card className="cursor-pointer transition-shadow hover:shadow-sm" onClick={onRenewals} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRenewals() } }} tabIndex={0} role="button" aria-label="Show deals eligible for renewal">
        <CardContent className="space-y-3 pt-5">
          <div>
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><RefreshCcw className="size-3.5" />Eligible for renewals</p>
            <p className="mt-1 text-2xl font-semibold">{dashboard.renewals.count}</p>
            <p className="text-xs text-muted-foreground">Typically 50%+ paid down. Click to filter the list.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
