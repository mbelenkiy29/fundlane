"use client"

import * as React from "react"
import { Label, Pie, PieChart, Sector } from "recharts"
import type { PieSectorDataItem } from "recharts/types/polar/Pie"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartStyle, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import {
  EMPTY_DASHBOARD2,
  NO_ACTIVITY_YET,
  RESTRICTED_LABEL,
  revenueBreakdownCsv,
  type Dashboard2View,
} from "@/lib/mca/dashboard2/map-kpis"

const chartConfig = {
  revenue: {
    label: "Revenue",
  },
  amount: {
    label: "Amount",
  },
  funded: {
    label: "Funded",
    color: "var(--chart-1)",
  },
  commission: {
    label: "Commission",
    color: "var(--chart-2)",
  },
  fees: {
    label: "Fees",
    color: "var(--chart-3)",
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

export function RevenueBreakdown({ revenue }: { revenue?: Dashboard2View["revenue"] }) {
  const id = "revenue-breakdown"
  const data = revenue ?? EMPTY_DASHBOARD2.revenue
  const [activeCategory, setActiveCategory] = React.useState(data.slices[0]?.category ?? "funded")

  const activeIndex = React.useMemo(() => {
    const index = data.slices.findIndex((item) => item.category === activeCategory)
    return index === -1 ? 0 : index
  }, [activeCategory, data.slices])

  const categories = React.useMemo(() => data.slices.map((item) => item.category), [data.slices])
  const active = data.slices[activeIndex]
  const message = data.restricted ? RESTRICTED_LABEL : data.empty ? NO_ACTIVITY_YET : null

  return (
    <Card data-chart={id} className="flex flex-col cursor-pointer">
      <ChartStyle id={id} config={chartConfig} />
      <CardHeader className="flex flex-col space-y-2 sm:flex-row sm:items-center sm:justify-between sm:space-y-0 pb-2">
        <div>
          <CardTitle>Revenue Breakdown</CardTitle>
          <CardDescription>Revenue distribution by source</CardDescription>
        </div>
        <div className="flex items-center space-x-2">
          <Select value={activeCategory} onValueChange={(value) => setActiveCategory(value as typeof activeCategory)}>
            <SelectTrigger
              className="w-[175px] rounded-lg cursor-pointer"
              aria-label="Select a category"
            >
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent align="end" className="rounded-lg">
              {categories.map((key) => {
                const config = chartConfig[key as keyof typeof chartConfig]

                if (!config) {
                  return null
                }

                return (
                  <SelectItem
                    key={key}
                    value={key}
                    className="rounded-md [&_span]:flex cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="flex h-3 w-3 shrink-0 "
                        style={{
                          backgroundColor: `var(--color-${key})`,
                        }}
                      />
                      {config?.label}
                    </div>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => downloadCsv("revenue-breakdown.csv", revenueBreakdownCsv(data.slices, data.restricted))}
          >
            Export
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 justify-center">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
          <div className="flex justify-center">
            {message ? (
              <div className="flex aspect-square w-full max-w-[300px] items-center justify-center text-sm text-muted-foreground">
                {message}
              </div>
            ) : (
              <ChartContainer
                id={id}
                config={chartConfig}
                className="mx-auto aspect-square w-full max-w-[300px]"
              >
                <PieChart>
                  <ChartTooltip
                    cursor={false}
                    content={<ChartTooltipContent hideLabel />}
                  />
                  <Pie
                    data={data.slices.map((item) => ({ category: item.category, amount: item.amount, fill: item.fill }))}
                    dataKey="amount"
                    nameKey="category"
                    innerRadius={60}
                    strokeWidth={5}
                    activeShape={({
                      outerRadius = 0,
                      ...props
                    }: PieSectorDataItem) => (
                      <g>
                        <Sector {...props} outerRadius={outerRadius + 10} />
                        <Sector
                          {...props}
                          outerRadius={outerRadius + 25}
                          innerRadius={outerRadius + 12}
                        />
                      </g>
                    )}
                  >
                    <Label
                      content={({ viewBox }) => {
                        if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                          const center = active?.restricted
                            ? RESTRICTED_LABEL
                            : `$${((active?.amount ?? 0) / 1000).toFixed(0)}K`
                          return (
                            <text
                              x={viewBox.cx}
                              y={viewBox.cy}
                              textAnchor="middle"
                              dominantBaseline="middle"
                            >
                              <tspan
                                x={viewBox.cx}
                                y={viewBox.cy}
                                className="fill-foreground text-3xl font-bold"
                              >
                                {center}
                              </tspan>
                              <tspan
                                x={viewBox.cx}
                                y={(viewBox.cy || 0) + 24}
                                className="fill-muted-foreground"
                              >
                                Revenue
                              </tspan>
                            </text>
                          )
                        }
                      }}
                    />
                  </Pie>
                </PieChart>
              </ChartContainer>
            )}
          </div>

          <div className="flex flex-col justify-center space-y-4">
            {data.slices.map((item, index) => {
              const config = chartConfig[item.category as keyof typeof chartConfig]
              const isActive = index === activeIndex

              return (
                <div
                  key={item.category}
                  className={`flex items-center justify-between p-3 rounded-lg transition-colors cursor-pointer ${
                    isActive ? 'bg-muted' : 'hover:bg-muted/50'
                  }`}
                  onClick={() => setActiveCategory(item.category)}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="flex h-3 w-3 shrink-0 rounded-full"
                      style={{
                        backgroundColor: `var(--color-${item.category})`,
                      }}
                    />
                    <span className="font-medium">{config?.label}</span>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">
                      {item.restricted ? RESTRICTED_LABEL : `$${(item.amount / 1000).toFixed(1)}K`}
                    </div>
                    <div className="text-sm text-muted-foreground">{item.restricted ? "—" : `${item.value}%`}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
