"use client"

export interface UploadOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export function uploadMultipart<T>(url: string, form: FormData, onProgress: (percent: number) => void, options: UploadOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    let settled = false
    const finish = (error?: Error, payload?: T) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener("abort", abort)
      if (error) reject(error)
      else resolve(payload as T)
    }
    const abort = () => {
      finish(new Error("Upload was interrupted. Retry with the same file."))
      request.abort()
    }
    request.open("POST", url)
    request.timeout = options.timeoutMs ?? 0
    request.upload.addEventListener("progress", (event) => {
      if (!settled && event.lengthComputable) onProgress(event.loaded === event.total ? 100 : Math.min(99, Math.round((event.loaded / event.total) * 100)))
    })
    request.upload.addEventListener("load", () => { if (!settled) onProgress(100) })
    request.addEventListener("load", () => {
      if (settled) return
      let payload: unknown
      try { payload = JSON.parse(request.responseText) } catch {
        finish(new Error("The server returned an invalid response. Retry with the same file."))
        return
      }
      if (request.status >= 200 && request.status < 300) finish(undefined, payload as T)
      else finish(new Error((payload as { error?: { message?: string } } | null)?.error?.message ?? "Upload failed. Retry with the same file."))
    })
    request.addEventListener("error", () => finish(new Error("Upload was interrupted. Retry with the same file.")))
    request.addEventListener("abort", () => finish(new Error("Upload was interrupted. Retry with the same file.")))
    request.addEventListener("timeout", () => finish(new Error("The request timed out. Retry with the same file, source and batch IDs to recover the preview.")))
    if (options.signal?.aborted) { abort(); return }
    options.signal?.addEventListener("abort", abort, { once: true })
    try { request.send(form) } catch (error) { finish(error instanceof Error ? error : new Error("Upload could not start.")) }
  })
}
