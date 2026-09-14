import { requirePlatformOwner } from "@/lib/mca/operations/access"
import { platformErrors } from "@/lib/mca/operations/status"
import { parseWindow, sinceFor } from "@/lib/mca/operations/contracts"
import { apiError } from "@/lib/mca/errors"
export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  try {
    await requirePlatformOwner()
    const p = new URL(request.url).searchParams,
      component = p.get("component"),
      before = p.get("before")
    let window
    try {
      window = parseWindow(p.get("window"))
    } catch {
      return new Response(null, { status: 400 })
    }
    if (
      (component &&
        !["api", "worker", "database", "email"].includes(component)) ||
      (before &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          before
        ))
    )
      return new Response(null, { status: 400 })
    const rows = await platformErrors(sinceFor(window), component, before)
    return Response.json(
      { errors: rows, next: rows.length === 50 ? rows.at(-1)!.id : null },
      { headers: { "cache-control": "private, no-store" } }
    )
  } catch (error) {
    const response = apiError(error)
    response.headers.set("cache-control", "no-store")
    return response
  }
}
