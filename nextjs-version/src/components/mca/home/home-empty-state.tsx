"use client"

import Link from "next/link"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { HOME_KPI_COPY } from "@/lib/mca/home/kpi-strip"
import type { SetupStep } from "@/lib/mca/setup/contracts"

export function HomeEmptyState({
  canCreateDeal,
  onCreate,
  nextStep,
}: {
  canCreateDeal: boolean
  onCreate: () => void
  nextStep?: SetupStep | null
}) {
  const nextIsDeal = !nextStep || nextStep.id === "first_deal"
  return (
    <Card data-testid="mca-home-empty">
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <div>
          <p className="font-medium">{HOME_KPI_COPY.emptyTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{HOME_KPI_COPY.emptyDescription}</p>
          {nextStep && !nextIsDeal ? (
            <p className="mt-2 text-sm text-muted-foreground">Next setup step: {nextStep.title}.</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canCreateDeal ? (
            <Button type="button" onClick={onCreate}>
              <Plus />
              {HOME_KPI_COPY.emptyAction}
            </Button>
          ) : null}
          {nextStep && !nextIsDeal ? (
            <Button asChild variant="outline">
              <Link href={nextStep.href}>{nextStep.actionLabel}</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
