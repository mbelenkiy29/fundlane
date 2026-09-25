"use client"

import { FileWarning } from "lucide-react"
import {
  describeMissingRequiredFields,
  missingRequiredFieldLabel,
} from "@/lib/mca/deals/validation"

export function MissingFieldsCount({ fields }: { fields: string[] }) {
  const labels = fields.map(missingRequiredFieldLabel)
  const countLabel = `${fields.length} missing ${fields.length === 1 ? "field" : "fields"}`
  return (
    <span className="inline-flex max-w-48 flex-col items-start gap-0.5 text-amber-600" title={labels.join(", ")}>
      <span className="inline-flex items-center gap-1">
        <FileWarning className="size-3.5 shrink-0" />
        {countLabel}
      </span>
      <span className="line-clamp-2 text-xs text-muted-foreground">{labels.join(", ")}</span>
    </span>
  )
}

export function MissingSubmissionFields({
  fields,
  onSelect,
}: {
  fields: string[]
  onSelect?: (field: string) => void
}) {
  if (!fields.length) return null
  const items = describeMissingRequiredFields(fields)
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
        <FileWarning className="size-4" />
        Partial draft · {fields.length} missing {fields.length === 1 ? "field" : "fields"}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {items.map((item) => (
          <li key={item.key}>
            {onSelect ? (
              <button
                type="button"
                className="text-xs text-amber-800 underline underline-offset-2 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
                onClick={() => onSelect(item.key)}
              >
                {item.label}
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">{item.label}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
