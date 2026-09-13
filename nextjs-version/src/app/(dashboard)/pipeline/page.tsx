import { DealsWorkspace } from "./components/pipeline-workspace"
import { ApplicationScanPanel } from "@/components/mca/documents/application-scan-panel"

export default function PipelinePage() {
  return <div className="space-y-6"><ApplicationScanPanel /><DealsWorkspace /></div>
}
