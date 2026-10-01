import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { StatusDashboard } from "@/components/mca/operations/status-dashboard"
import { documentRuntimeEnabled } from "@/lib/mca/jobs/document-runtime"

export const dynamic = "force-dynamic"
export default async function MonitoringPage() {
  await requirePlatformPage()
  return <StatusDashboard documentRuntimeEnabled={documentRuntimeEnabled()} />
}
