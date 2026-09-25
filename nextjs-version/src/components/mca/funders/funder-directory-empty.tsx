"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"

export function FunderDirectoryEmpty({
  hasFunders,
  canManage,
  onCreate,
}: {
  hasFunders: boolean
  canManage: boolean
  onCreate: () => void
}) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="mca-funders-empty">
      {hasFunders ? (
        "No active funders. Turn on Show inactive to review archived profiles."
      ) : (
        <div className="space-y-3">
          <p>No funders yet. Add the first funder profile to start routing submissions.</p>
          {canManage ? (
            <Button type="button" onClick={onCreate}>
              <Plus />
              Add your first funder
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
