import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { hasUnnotifiedDemoSubmissions, listDemoSubmissions } from "@/lib/marketing/demo-storage"
import { apiError } from "@/lib/mca/errors"

export async function GET(request?: Request) {
  try {
    await requireSuperAdmin(request)
    const [rows, unnotified] = await Promise.all([listDemoSubmissions(), hasUnnotifiedDemoSubmissions()])
    return Response.json({ rows, unnotified }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
