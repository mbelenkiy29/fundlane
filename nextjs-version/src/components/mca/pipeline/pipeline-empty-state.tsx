"use client"

import { Building2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

export function PipelineEmptyState({
  filtered,
  onCreate,
}: {
  filtered: boolean
  onCreate: () => void
}) {
  return (
    <Card data-testid="mca-pipeline-empty">
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <div className="rounded-full bg-muted p-4">
          <Building2 className="size-7" />
        </div>
        <div>
          <p className="font-medium">{filtered ? "No deals match this view" : "No deals yet"}</p>
          <p className="text-sm text-muted-foreground">
            {filtered
              ? "Clear filters or save a partial merchant application."
              : "Create your first merchant application to open this pipeline."}
          </p>
        </div>
        <Button onClick={onCreate}>
          <Plus className="mr-2 size-4" />
          {filtered ? "New deal" : "Create your first deal"}
        </Button>
      </CardContent>
    </Card>
  )
}
