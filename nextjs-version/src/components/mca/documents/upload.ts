"use client"

export function uploadMultipart<T>(url: string, form: FormData, onProgress: (percent: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open("POST", url)
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    })
    request.addEventListener("load", () => {
      let payload: unknown = {}
      try { payload = JSON.parse(request.responseText) } catch { /* handled below */ }
      if (request.status >= 200 && request.status < 300) resolve(payload as T)
      else reject(new Error((payload as { error?: { message?: string } }).error?.message ?? "Upload failed. Retry with the same file."))
    })
    request.addEventListener("error", () => reject(new Error("Upload was interrupted. Retry with the same file.")))
    request.addEventListener("abort", () => reject(new Error("Upload was interrupted. Retry with the same file.")))
    request.send(form)
  })
}
