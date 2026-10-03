import { Suspense } from "react"
import { PipelineLoading } from "./components/pipeline-loading"
import { DealsWorkspace } from "./components/pipeline-workspace"

export default function PipelinePage() {
  return (
    <Suspense fallback={<PipelineLoading />}>
      <DealsWorkspace autoSubmitEnabled={process.env.MCA_AUTO_SUBMIT_ENABLED === "true"} estimatesEnabled={process.env.MCA_DEAL_ESTIMATES_ENABLED === "true"} />
    </Suspense>
  )
}
