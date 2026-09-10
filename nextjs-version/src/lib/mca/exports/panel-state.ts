import { EXPORT_PANEL_COPY, type ExportCapabilities, type ExportJobView } from "./contracts"

export type ExportPanelStatus = "loading" | "disabled" | "empty" | "validation" | "queued" | "ready" | "failed"

export interface ExportPanelView {
  status: ExportPanelStatus
  message: string
  jobs: ExportJobView[]
  workspaceAvailable: boolean
  exportEnabled: boolean
}

export function exportPanelView(input: {
  loading: boolean
  error?: string
  fieldErrors?: Record<string, string[]>
  jobs?: ExportJobView[]
  capabilities?: ExportCapabilities
}): ExportPanelView {
  const jobs = input.jobs ?? []
  const exportEnabled = input.capabilities?.exportEnabled !== false
  const workspaceAvailable = Boolean(input.capabilities?.workspace)
  if (input.loading) return { status: "loading", message: EXPORT_PANEL_COPY.loading, jobs, workspaceAvailable, exportEnabled }
  if (input.capabilities && !input.capabilities.exportEnabled) {
    return { status: "disabled", message: EXPORT_PANEL_COPY.disabled, jobs: [], workspaceAvailable: false, exportEnabled: false }
  }
  if (input.fieldErrors && Object.keys(input.fieldErrors).length) {
    return { status: "validation", message: EXPORT_PANEL_COPY.validation, jobs, workspaceAvailable, exportEnabled }
  }
  if (input.error) return { status: "failed", message: input.error, jobs, workspaceAvailable, exportEnabled }
  if (jobs.some((job) => job.state === "queued")) {
    return { status: "queued", message: EXPORT_PANEL_COPY.queued, jobs, workspaceAvailable, exportEnabled }
  }
  if (jobs.some((job) => job.state === "failed")) {
    return { status: "failed", message: EXPORT_PANEL_COPY.failed, jobs, workspaceAvailable, exportEnabled }
  }
  if (!jobs.length) return { status: "empty", message: EXPORT_PANEL_COPY.empty, jobs, workspaceAvailable, exportEnabled }
  return { status: "ready", message: EXPORT_PANEL_COPY.success, jobs, workspaceAvailable, exportEnabled }
}
