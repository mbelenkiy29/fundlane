import { DealsWorkspace } from "./components/deals-workspace"
import { ApplicationScanPanel } from "@/components/mca/documents/application-scan-panel"

export default function DealsPage() {
  return <div className="space-y-6"><ApplicationScanPanel /><DealsWorkspace /></div>
}
