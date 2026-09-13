"use client"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function DuplicateMerchantDialog({
  open,
  onOpenChange,
  merchantName,
  busy,
  onAttach,
  onCreateNew,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  merchantName: string
  busy?: boolean
  onAttach: () => void
  onCreateNew: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Business already exists</DialogTitle>
          <DialogDescription>{`This business already exists: ${merchantName}`}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button type="button" variant="secondary" onClick={onCreateNew} disabled={busy}>Create new anyway</Button>
          <Button type="button" onClick={onAttach} disabled={busy}>Attach to existing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
