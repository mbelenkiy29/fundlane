"use client"

import Link from "next/link"
import { Check, Circle, ListChecks, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { SETUP_COPY, type WorkspaceSetup } from "@/lib/mca/setup/contracts"

export function SetupChecklist({
  setup,
  dismissing,
  onDismiss,
}: {
  setup: WorkspaceSetup
  dismissing?: boolean
  onDismiss: () => void
}) {
  if (setup.dismissed) return null
  const progress = setup.totalCount ? Math.round((setup.completedCount / setup.totalCount) * 100) : 0

  return (
    <Card data-testid="mca-setup-checklist">
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="size-5" />
              {setup.allComplete ? SETUP_COPY.completeTitle : SETUP_COPY.title}
            </CardTitle>
            <CardDescription>
              {setup.allComplete ? SETUP_COPY.completeDescription : SETUP_COPY.description}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={dismissing}
            onClick={onDismiss}
            aria-label={SETUP_COPY.dismissAria}
          >
            <X />
            {SETUP_COPY.dismiss}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{SETUP_COPY.progress(setup.completedCount, setup.totalCount)}</p>
          <Progress value={progress} aria-label={SETUP_COPY.progress(setup.completedCount, setup.totalCount)} />
        </div>
        <ol className="space-y-2">
          {setup.steps.map((item) => (
            <li key={item.id} className="flex items-start gap-3 rounded-lg border p-3">
              {item.complete ? (
                <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${item.complete ? "text-muted-foreground line-through" : ""}`}>
                  {item.title}
                </p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
              {!item.complete ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={item.href}>{item.actionLabel}</Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
