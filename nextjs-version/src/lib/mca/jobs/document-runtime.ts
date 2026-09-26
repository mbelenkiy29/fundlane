export function documentRuntimeEnabled(): boolean {
  return process.env.MCA_DOCUMENT_JOB_RUNTIME === "vercel_cron" || process.env.MCA_NATIVE_DOCUMENT_EXECUTOR === "true"
}
