"use client"

import * as React from "react"
import { NewDealModal } from "@/components/mca/deals/new-deal-modal"

export type CreatedDeal = { id: string; displayId: string; draftState?: string }

type NewDealContextValue = {
  open: () => void
  openNewDeal: () => void
  close: () => void
  subscribe: (listener: (deal: CreatedDeal) => void) => () => void
}

const NewDealContext = React.createContext<NewDealContextValue | null>(null)

export function useNewDeal() {
  const value = React.useContext(NewDealContext)
  if (!value) throw new Error("useNewDeal must be used within NewDealProvider")
  return value
}

export function useOptionalNewDeal() {
  return React.useContext(NewDealContext)
}

export function NewDealProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const listeners = React.useRef(new Set<(deal: CreatedDeal) => void>())
  const value = React.useMemo<NewDealContextValue>(() => {
    const open = () => setOpen(true)
    return {
      open,
      openNewDeal: open,
      close: () => setOpen(false),
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => { listeners.current.delete(listener) }
      },
    }
  }, [])

  return (
    <NewDealContext.Provider value={value}>
      {children}
      <NewDealModal
        open={open}
        onOpenChange={setOpen}
        onCreated={(deal) => {
          for (const listener of listeners.current) listener(deal)
        }}
      />
    </NewDealContext.Provider>
  )
}
