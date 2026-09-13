"use client"

import { useState } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import type { HomeKpis } from "@/lib/mca/home/kpi-contracts"
import {
  mapSalesChart,
  NO_ACTIVITY_YET,
  RESTRICTED_LABEL,
  salesChartCsv,
  type Dashboard2SalesRange,
} from "@/lib/mca/dashboard2/map-kpis"

const chartConfig = {
  sales: {
    label: "Funded",
    color: "var(--primary)",
  },
  target: {
    label: "Commission",
    color: "var(--primary)",
  },
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function SalesChart({ kpis }: { kpis?: HomeKpis | null }) {
  const [timeRange, setTimeRange] = useState<Dashboard2SalesRange>("12m")
  const sales = mapSalesChart(kpis ?? null, timeRange)
  const message = sales.restricted ? RESTRICTED_LABEL : sales.empty ? NO_ACTIVITY_YET : null

  return (
    <Card className="cursor-pointer">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle>Sales Performance</CardTitle>
          <CardDescription>Monthly funded vs commission</CardDescription>
        </div>
        <div className="flex items-center space-x-2">
          <Select value={timeRange} onValueChange={(value) => setTimeRange(value as Dashboard2SalesRange)}>
            <SelectTrigger className="w-32 cursor-pointer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="3m" className="cursor-pointer">Last 3 months</SelectItem>
              <SelectItem value="6m" className="cursor-pointer">Last 6 months</SelectItem>
              <SelectItem value="12m" className="cursor-pointer">Last 12 months</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => downloadCsv("funded-by-month.csv", salesChartCsv(sales.points, sales.restricted))}
          >
            Export
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-6">
        <div className="px-6 pb-6">
          {message ? (
            <div className="flex h-[350px] items-center justify-center text-sm text-muted-foreground">{message}</div>
          ) : (
            <ChartContainer config={chartConfig} className="h-[350px] w-full">
              <AreaChart data={sales.points} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-sales)" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="var(--color-sales)" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="colorTarget" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-target)" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="var(--color-target)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted/30" />
                <XAxis 
                  dataKey="month" 
                  axisLine={false}
                  tickLine={false}
                  className="text-xs"
                  tick={{ fontSize: 12 }}
                />
                <YAxis 
                  axisLine={false}
                  tickLine={false}
                  className="text-xs"
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value) => `$${value.toLocaleString()}`}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                {sales.plotTarget ? (
                  <Area
                    type="monotone"
                    dataKey="target"
                    stackId="1"
                    stroke="var(--color-target)"
                    fill="url(#colorTarget)"
                    strokeDasharray="5 5"
                    strokeWidth={1}
                  />
                ) : null}
                {sales.plotSales ? (
                  <Area
                    type="monotone"
                    dataKey="sales"
                    stackId="2"
                    stroke="var(--color-sales)"
                    fill="url(#colorSales)"
                    strokeWidth={1}
                  />
                ) : null}
              </AreaChart>
            </ChartContainer>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
