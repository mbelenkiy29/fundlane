import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"

export function NewDealHeaderAction({ onOpen }: { onOpen: () => void }) {
  return (
    <Button
      type="button"
      size="sm"
      className="hidden sm:inline-flex"
      aria-label="New deal"
      onClick={onOpen}
    >
      <Plus />
      <span className="hidden md:inline">New deal</span>
    </Button>
  )
}
