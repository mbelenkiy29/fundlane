"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { HOME_KPI_COPY } from "@/lib/mca/home/kpi-strip"

export function HomeEmptyState({
  canCreateDeal,
  onCreate,
}: {
  canCreateDeal: boolean
  onCreate: () => void
}) {
  return (
    <Card data-testid="mca-home-empty">
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <div>
          <p className="font-medium">{HOME_KPI_COPY.emptyTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{HOME_KPI_COPY.emptyDescription}</p>
        </div>
        {canCreateDeal ? (
          <Button type="button" onClick={onCreate}>
            <Plus />
            {HOME_KPI_COPY.emptyAction}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}
