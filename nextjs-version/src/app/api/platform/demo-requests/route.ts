import { requirePlatformAdmin } from "@/lib/mca/platform-auth"
import { demoVisibilityEnabled, hasUnnotifiedDemoSubmissions, listDemoSubmissions } from "@/lib/marketing/demo-storage"
import { apiError, AppError } from "@/lib/mca/errors"

export async function GET() {
  try {
    await requirePlatformAdmin()
    if (!demoVisibilityEnabled()) throw new AppError(404, "not_found", "Not found.")
    const [rows, unnotified] = await Promise.all([listDemoSubmissions(), hasUnnotifiedDemoSubmissions()])
    return Response.json({ rows, unnotified }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
