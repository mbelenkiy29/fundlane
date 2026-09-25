"use client"

import * as React from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export const REPORT_VALUE_HINTS = {
  restricted:
    "Restricted means your role or workspace cannot view this financial figure. Missing permission is not shown as $0.",
  na: "N/A means this rate cannot be calculated because the denominator is zero or the source value is missing. This is not a 0% result.",
  undefined:
    "Undefined means ROI cannot be computed when purchase cost is $0. This is not infinity or 0%.",
} as const

export type ReportValueKind = keyof typeof REPORT_VALUE_HINTS

export function ExplainedValue({
  kind,
  children,
}: {
  kind: ReportValueKind
  children: React.ReactNode
}) {
  const hint = REPORT_VALUE_HINTS[kind]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="cursor-help border-b border-dotted border-muted-foreground/70 text-left"
          aria-label={`${String(children)}. ${hint}`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-pretty">{hint}</TooltipContent>
    </Tooltip>
  )
}

export function explainedReportValue(value: string): React.ReactNode {
  if (value === "Restricted") return <ExplainedValue kind="restricted">{value}</ExplainedValue>
  if (value === "N/A") return <ExplainedValue kind="na">{value}</ExplainedValue>
  if (value === "Undefined") return <ExplainedValue kind="undefined">{value}</ExplainedValue>
  return value
}

export function ReportEmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center">
      <p className="font-medium">{title}</p>
      {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
    </div>
  )
}
