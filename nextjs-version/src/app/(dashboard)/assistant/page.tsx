import { Suspense } from "react"
import { AssistantWorkspace } from "@/components/mca/assistant/assistant-workspace"
export default function AssistantPage() {
  return (
    <Suspense fallback={<p>Loading assistant…</p>}>
      <div className="mx-auto w-full max-w-7xl p-4 md:p-6">
        <AssistantWorkspace />
      </div>
    </Suspense>
  )
}
