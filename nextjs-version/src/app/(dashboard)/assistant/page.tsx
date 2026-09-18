import { Suspense } from "react"
import { AssistantWorkspace } from "@/components/mca/assistant/assistant-workspace"
export default function AssistantPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading assistant…</p>}>
      <div className="-my-4 h-[calc(100dvh-var(--header-height))] min-h-0 overflow-hidden md:-my-6">
        <AssistantWorkspace />
      </div>
    </Suspense>
  )
}
