import { Suspense } from "react"
import { CreditsPanel } from "@/components/mca/assistant/credits-panel"
export default function CreditsPage() {
  return (
    <Suspense fallback={<p>Loading AI credits…</p>}>
      <div className="mx-auto w-full max-w-7xl p-4 md:p-6">
        <CreditsPanel />
      </div>
    </Suspense>
  )
}
