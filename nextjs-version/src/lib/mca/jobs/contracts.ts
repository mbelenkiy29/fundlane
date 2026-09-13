export const MULTIPART_TASK_ENDPOINTS = [
  "/api/mca/imports/preview", "/api/mca/imports/update/preview",
  "/api/mca/imports/archives/preview", "/api/mca/imports/archives/apply",
  "/api/mca/leads/packages/preview", "/api/mca/historical/preview", "/api/mca/funders/scan",
  "/api/mca/assistant/files",
] as const
export type MultipartTaskEndpoint = typeof MULTIPART_TASK_ENDPOINTS[number]
export interface MultipartTaskInput {
  endpoint: MultipartTaskEndpoint
  fields: Record<string, string>
  files: Array<{ field: "file" | "archives"; uploadId: string }>
}
