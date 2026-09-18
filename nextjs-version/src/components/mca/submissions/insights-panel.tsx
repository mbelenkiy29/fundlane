"use client"

import { Bar, BarChart, XAxis, YAxis } from "recharts"
import { Card, CardContent } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Skeleton } from "@/components/ui/skeleton"
import type { InsightWindow, SubmissionInsights } from "@/lib/mca/submissions/insights"

const chartConfig = {
  count: { label: "Submissions", color: "var(--primary)" },
}

function WindowToggle({
  value,
  onChange,
}: {
  value: InsightWindow
  onChange: (value: InsightWindow) => void
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={value}
      onValueChange={(next) => next && onChange(next as InsightWindow)}
      aria-label="Submissions time window"
    >
      <ToggleGroupItem value="today">Today</ToggleGroupItem>
      <ToggleGroupItem value="week">This week</ToggleGroupItem>
      <ToggleGroupItem value="month">This month</ToggleGroupItem>
    </ToggleGroup>
  )
}

export function SubmissionsInsightsPanel({
  insights,
  window,
  onWindowChange,
  loading,
}: {
  insights?: SubmissionInsights
  window: InsightWindow
  onWindowChange: (value: InsightWindow) => void
  loading: boolean
}) {
  const lenders = insights?.lenders ?? []

  return (
    <section aria-label="Submissions dashboard" className="grid gap-3 lg:grid-cols-3">
      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">Submissions</p>
              {loading && !insights ? (
                <Skeleton className="mt-1 h-8 w-16" />
              ) : (
                <p className="mt-1 text-2xl font-semibold tabular-nums">{insights?.submissions.count ?? 0}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {insights?.submissions.dealCount ?? 0}{" "}
                {(insights?.submissions.dealCount ?? 0) === 1 ? "business" : "businesses"}
              </p>
            </div>
          </div>
          <WindowToggle value={window} onChange={onWindowChange} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-5">
          <p className="text-sm text-muted-foreground">Broker leaderboard</p>
          {loading && !insights ? (
            <Skeleton className="h-24 w-full" />
          ) : !insights?.brokers.length ? (
            <p className="text-sm text-muted-foreground">No submissions in this window.</p>
          ) : (
            <ol className="space-y-2">
              {insights.brokers.slice(0, 8).map((broker, index) => (
                <li key={broker.membershipId} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="mr-2 tabular-nums text-muted-foreground">{index + 1}.</span>
                    {broker.name}
                  </span>
                  <span className="tabular-nums font-medium">{broker.count}</span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-5">
          <p className="text-sm text-muted-foreground">Most submissions by lender</p>
          {loading && !insights ? (
            <Skeleton className="h-40 w-full" />
          ) : !lenders.length ? (
            <p className="text-sm text-muted-foreground">No submissions in this window.</p>
          ) : (
            <ChartContainer config={chartConfig} className="aspect-auto h-44 w-full">
              <BarChart data={lenders} layout="vertical" margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" width={96} tickLine={false} axisLine={false} className="text-xs" />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={4} isAnimationActive={false} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
