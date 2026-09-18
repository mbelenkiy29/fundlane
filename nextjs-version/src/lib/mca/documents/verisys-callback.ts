import { apiError, AppError } from "../errors"
import { verifyVerisysSignature } from "./verisys"
import { recordScanResult } from "./verisys-store"

export async function scanCallback(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") throw new AppError(405,"method_not_allowed","Use POST.")
    const reader = request.body?.getReader()
    if (!reader) throw new AppError(400,"scan_result_missing","The scan result is missing.")
    const parts: Uint8Array[] = []; let length = 0
    try {
      while(true) { const next=await reader.read();if(next.done)break;length+=next.value.byteLength
        if(length>64000){await reader.cancel();throw new AppError(413,"scan_result_too_large","The scan result exceeds the limit.")}
        parts.push(next.value)
      }
    } finally { reader.releaseLock() }
    const raw = Buffer.concat(parts)
    verifyVerisysSignature(raw,request.headers.get("x-api-signature"))
    let payload: unknown
    try { payload=JSON.parse(raw.toString("utf8")) } catch { throw new AppError(400,"scan_result_invalid","The scan result is invalid.") }
    await recordScanResult(payload)
    return new Response(null,{status:204})
  } catch(error) { return apiError(error) }
}
