import { Suspense } from "react"
import { AssistantWorkspace } from "@/components/mca/assistant/assistant-workspace"

export default function AssistantPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm">Loading assistant…</p>}>
      <AssistantWorkspace />
    </Suspense>
  )
}
