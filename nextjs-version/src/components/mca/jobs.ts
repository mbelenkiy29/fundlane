"use client"

export async function awaitBackgroundResult<T>(initial: unknown, headers?: Record<string, string>, statusUrl?: string): Promise<T> {
  let job = initial as { jobId?: string; state?: string; result?: T; resultUrl?: string; error?: { message?: string } }
  if (!job.jobId) return initial as T
  const expires = Date.now() + 10 * 60_000
  while (job.state !== "complete") {
    if (job.state === "failed") throw new Error(job.error?.message ?? "Processing failed.")
    if (Date.now() > expires) throw new Error("Processing is continuing in the background. Refresh the page to check its status.")
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const response = await fetch(statusUrl ?? `/api/mca/jobs/${encodeURIComponent(job.jobId!)}`, { cache: "no-store", headers })
    job = await response.json()
    if (!response.ok) throw new Error(job.error?.message ?? "Processing status is unavailable.")
  }
  if (job.resultUrl) {
    const response = await fetch(job.resultUrl, { cache: "no-store", headers })
    if (!response.ok) throw new Error("The operation result is unavailable. Refresh the page and try again.")
    return response.json() as Promise<T>
  }
  return job.result as T
}
