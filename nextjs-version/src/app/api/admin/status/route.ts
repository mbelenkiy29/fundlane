import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { platformStatus } from "@/lib/mca/operations/status"
import { parseWindow } from "@/lib/mca/operations/contracts"
import { apiError } from "@/lib/mca/errors"
export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  try {
    await requireSuperAdmin(request)
    let window
    try {
      window = parseWindow(new URL(request.url).searchParams.get("window"))
    } catch {
      return Response.json(
        { error: "Invalid window" },
        { status: 400, headers: { "cache-control": "no-store" } }
      )
    }
    return Response.json(await platformStatus(window), {
      headers: { "cache-control": "private, no-store" },
    })
  } catch (error) {
    const response = apiError(error)
    response.headers.set("cache-control", "no-store")
    return response
  }
}
