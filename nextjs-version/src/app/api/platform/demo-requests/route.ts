import { requirePlatformAdmin } from "@/lib/mca/platform-auth"
import { hasUnnotifiedDemoSubmissions, listDemoSubmissions } from "@/lib/marketing/demo-storage"
import { apiError } from "@/lib/mca/errors"

export async function GET() {
  try {
    await requirePlatformAdmin()
    const [rows, unnotified] = await Promise.all([listDemoSubmissions(), hasUnnotifiedDemoSubmissions()])
    return Response.json({ rows, unnotified }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
