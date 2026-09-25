import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { getSampleStatementPdf } from "@/lib/mca/sandbox/statements"

export const runtime = "nodejs"

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
    const { statement, bytes } = await getSampleStatementPdf((await context.params).id, auth.workspaceId)
    return new Response(Buffer.from(bytes), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${statement.filename}"`,
        "x-fundlane-synthetic": "1",
      },
    })
  } catch (error) {
    return apiError(error)
  }
}
