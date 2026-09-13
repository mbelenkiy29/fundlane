"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

type DuplicateMerchantDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  merchantName: string
  busy?: boolean
  onAttach: () => void
  onCreateNew: () => void
}

const DuplicateMerchantDialogHostContext = React.createContext<{
  set: (id: string, props: React.MutableRefObject<DuplicateMerchantDialogProps> | null) => void
  notify: (id: string, props: DuplicateMerchantDialogProps) => void
} | null>(null)

function DuplicateMerchantDialogView({
  open,
  onOpenChange,
  merchantName,
  busy,
  onAttach,
  onCreateNew,
}: DuplicateMerchantDialogProps) {
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

export function DuplicateMerchantDialogHost({ children }: { children: React.ReactNode }) {
  const slots = React.useRef(new Map<string, React.MutableRefObject<DuplicateMerchantDialogProps>>())
  const [snapshots, setSnapshots] = React.useState(new Map<string, DuplicateMerchantDialogProps>())
  const host = React.useMemo(() => ({
    set(id: string, props: React.MutableRefObject<DuplicateMerchantDialogProps> | null) {
      if (props) slots.current.set(id, props)
      else slots.current.delete(id)
      setSnapshots((previous) => {
        const next = new Map(previous)
        if (props) next.set(id, props.current)
        else next.delete(id)
        return next
      })
    },
    notify(id: string, props: DuplicateMerchantDialogProps) {
      setSnapshots((previous) => new Map(previous).set(id, props))
    },
  }), [])
  const values = [...snapshots.values()]
  const active = values.find((item) => item.open) ?? values[0]
  function latest(): DuplicateMerchantDialogProps {
    const current = [...slots.current.values()].map((slot) => slot.current)
    const next = current.find((item) => item.open) ?? current[0] ?? active
    if (!next) throw new Error("Duplicate merchant dialog is not mounted.")
    return next
  }
  return (
    <DuplicateMerchantDialogHostContext.Provider value={host}>
      {children}
      {active ? (
        <DuplicateMerchantDialogView
          open={active.open}
          merchantName={active.merchantName}
          busy={active.busy}
          onOpenChange={(open) => latest().onOpenChange(open)}
          onAttach={() => latest().onAttach()}
          onCreateNew={() => latest().onCreateNew()}
        />
      ) : null}
    </DuplicateMerchantDialogHostContext.Provider>
  )
}

export function DuplicateMerchantDialog(props: DuplicateMerchantDialogProps) {
  const host = React.useContext(DuplicateMerchantDialogHostContext)
  const id = React.useId()
  const propsRef = React.useRef(props)
  React.useLayoutEffect(() => {
    propsRef.current = props
  })
  React.useLayoutEffect(() => {
    if (!host) return
    host.set(id, propsRef)
    return () => host.set(id, null)
  }, [host, id])
  React.useLayoutEffect(() => {
    host?.notify(id, propsRef.current)
  }, [host, id, props.open, props.merchantName, props.busy])
  if (host) return null
  return <DuplicateMerchantDialogView {...props} />
}
