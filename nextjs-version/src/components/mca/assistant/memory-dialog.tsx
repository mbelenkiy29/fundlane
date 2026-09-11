"use client"
import { useEffect, useState } from "react"
import { Brain, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { assistantJson } from "./credit-balance"
import {
  memoryCategories,
  type MemoryView
} from "@/lib/mca/assistant/experience-contracts"
const labels = {
  writing_style: "Writing style",
  format: "Format preferences",
  terminology: "Terminology",
  workflow: "How you work"
}
type MemoryData = { enabled: boolean; memories: MemoryView[] }
export function MemoryDialog() {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<MemoryData | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false)
  const [category, setCategory] =
      useState<(typeof memoryCategories)[number]>("writing_style"),
    [text, setText] = useState("")
  useEffect(() => {
    if (open)
      void assistantJson<MemoryData>("/api/mca/assistant/memory")
        .then(setData)
        .catch((e) => setError(e.message))
  }, [open])
  async function change(command: unknown) {
    setBusy(true)
    setError("")
    try {
      setData(
        await assistantJson<MemoryData>("/api/mca/assistant/memory", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command)
        })
      )
      setText("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update memory.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Brain className="size-4" />
          Memory
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Your assistant memory</DialogTitle>
          <DialogDescription>
            Private to your profile in this company. The assistant can remember
            your stated preferences and recall permitted past conversations. It
            checks current deal facts again.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {data && (
          <>
            <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
              <span>Remember preferences and recall chats</span>
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={data.enabled}
                disabled={busy}
                onChange={(e) =>
                  void change({ action: "enabled", enabled: e.target.checked })
                }
              />
            </label>
            <div className="space-y-2">
              {data.memories.length ? (
                data.memories.map((m) => (
                  <div key={m.id} className="flex gap-2 rounded-lg border p-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        {labels[m.category as keyof typeof labels] ??
                          m.category}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                        {m.text}
                      </p>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Edit ${m.category} memory`}
                      onClick={() => {
                        setCategory(m.category as typeof category)
                        setText(m.text)
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Delete ${m.category} memory`}
                      onClick={() =>
                        void change({ action: "delete", id: m.id })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))
              ) : (
                <p className="py-3 text-sm text-muted-foreground">
                  No saved preferences yet. You can add one below.
                </p>
              )}
            </div>
            <form
              className="space-y-3 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault()
                void change({ action: "save", category, text })
              }}
            >
              <label
                htmlFor="memory-category"
                className="block text-sm font-medium"
              >
                Add or update a preference
              </label>
              <select
                id="memory-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as typeof category)}
                className="w-full rounded-md border bg-background p-2 text-sm"
              >
                {memoryCategories.map((c) => (
                  <option key={c} value={c}>
                    {labels[c]}
                  </option>
                ))}
              </select>
              <Textarea
                aria-label="Preference"
                placeholder="For example: Keep my emails short, friendly, and direct."
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
              />
              <div className="flex justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || !data.memories.length}
                  onClick={() => void change({ action: "clear" })}
                >
                  Clear saved preferences
                </Button>
                <Button type="submit" disabled={busy || !text.trim()}>
                  Save
                </Button>
              </div>
            </form>
            <p className="text-xs text-muted-foreground">
              Turning memory off also disables cross-conversation recall.
              Existing chat history stays available to you. Deleted preferences
              will not be relearned from older chats.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
