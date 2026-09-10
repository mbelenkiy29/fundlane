import { Suspense } from "react"
import { OffersWorkspace } from "@/components/mca/offers-workspace"

export default function OffersPage() {
  return <Suspense fallback={<p className="px-6" role="status">Loading offers…</p>}><OffersWorkspace /></Suspense>
}
