import type { DealStatus } from "@/lib/mca/deals/schema"

type Detail = { id: string; version: number }
type Snapshot<T> = {
  id: string | null
  selected: T | null
  loading: boolean
  failure: string
  note: string
  transition: DealStatus | ""
}

/** One dialog selection, including close/reopen of the same deal, owns its async results. */
export function createDealDetailSession<T extends Detail>(load: (id: string) => Promise<T>) {
  let generation = 0
  let snapshot: Snapshot<T> = { id: null, selected: null, loading: false, failure: "", note: "", transition: "" }
  const listeners = new Set<() => void>()
  function publish(next: Snapshot<T>) {
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  const capture = () => generation
  const isCurrent = (token: number) => snapshot.id !== null && token === generation
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    capture,
    isCurrent,
    async open(id: string) {
      const token = ++generation
      publish({ id, selected: null, loading: true, failure: "", note: "", transition: "" })
      try {
        const selected = await load(id)
        if (isCurrent(token)) publish({ ...snapshot, selected, loading: false })
      } catch (error) {
        if (isCurrent(token)) publish({ ...snapshot, loading: false, failure: error instanceof Error ? error.message : "Could not load deal." })
      }
    },
    close() {
      generation++
      publish({ id: null, selected: null, loading: false, failure: "", note: "", transition: "" })
    },
    update(selected: T) {
      if (selected.id !== snapshot.id || selected.version < (snapshot.selected?.version ?? 0)) return false
      publish({ ...snapshot, selected })
      return true
    },
    setNote(note: string) { publish({ ...snapshot, note }) },
    setTransition(transition: DealStatus | "") { publish({ ...snapshot, transition }) },
  }
}
