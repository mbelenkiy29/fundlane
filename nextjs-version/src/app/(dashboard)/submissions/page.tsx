import { Suspense } from "react"
import { SubmissionsDashboard } from "@/components/mca/submissions/dashboard"
export default function SubmissionsPage() {
  return (
    <Suspense fallback={<p role="status">Loading submissions…</p>}>
      <SubmissionsDashboard />
    </Suspense>
  )
}
