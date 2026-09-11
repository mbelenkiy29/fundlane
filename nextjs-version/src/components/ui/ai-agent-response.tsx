"use client"

import {
  Check,
  ChevronDown,
  Circle,
  FileText,
  Globe,
  Loader2,
  Sparkles,
  Wrench,
  X
} from "lucide-react"
import type { Activity } from "@/lib/mca/assistant/experience-contracts"

/** Adapted from the supplied agent-response design. Every row is a persisted server event. */
export function AgentWorkflow({ activities }: { activities: Activity[] }) {
  if (!activities.length) return null
  const running = activities.some((a) => a.status === "running")
  return (
    <details className="group mb-3 rounded-lg border bg-muted/20 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {running ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" />
        ) : (
          <Check className="size-3.5 text-primary" />
        )}
        <span>{running ? "Working on your request" : "Activity"}</span>
        <span className="ml-auto tabular-nums">
          {activities.length} {activities.length === 1 ? "step" : "steps"}
        </span>
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <ol className="space-y-3 border-t px-3 py-3">
        {activities.map((a) => {
          const Icon =
            a.kind === "reasoning"
              ? Sparkles
              : a.kind === "research"
                ? Globe
                : a.kind === "file"
                  ? FileText
                  : Wrench
          const Status =
            a.status === "running"
              ? Loader2
              : a.status === "completed"
                ? Check
                : a.status === "cancelled"
                  ? Circle
                  : X
          return (
            <li key={a.id} className="flex gap-2.5">
              <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{a.label}</span>
                  <Status
                    aria-label={a.status}
                    className={`ml-auto size-3.5 shrink-0 ${a.status === "running" ? "motion-safe:animate-spin" : a.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                  />
                </div>
                {a.text && (
                  <p className="mt-1.5 whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">
                    {a.text}
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </details>
  )
}
