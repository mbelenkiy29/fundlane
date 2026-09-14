"use client"

import { Area, AreaChart } from "recharts"
import { ChartContainer } from "@/components/ui/chart"
import type { HomeKpiSparkPoint } from "@/lib/mca/home/kpi-strip"

const chartConfig = {
  v: { label: "Trend", color: "var(--primary)" },
}

export function KpiSparkline({
  points,
  hidden,
  label,
}: {
  points: HomeKpiSparkPoint[]
  hidden: boolean
  label: string
}) {
  if (hidden || points.length < 2) return null
  if (!points.some((point) => point.v !== 0)) return null
  const gradientId = `kpi-spark-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-16 w-full" aria-hidden="true">
      <AreaChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-v)" stopOpacity={0.35} />
            <stop offset="95%" stopColor="var(--color-v)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke="var(--color-v)"
          fill={`url(#${gradientId})`}
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
