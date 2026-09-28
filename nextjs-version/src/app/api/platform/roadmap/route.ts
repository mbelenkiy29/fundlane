import { NextResponse } from "next/server"
import { publicRoadmapEnabled } from "@/lib/marketing/launch-switches"
import { requirePlatformAdmin } from "@/lib/mca/platform-auth"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { readJson } from "@/lib/mca/http"
import { createRoadmapItem, listRoadmapItems, roadmapItemSchema } from "@/lib/mca/roadmap-admin"
import { apiError, AppError } from "@/lib/mca/errors"

function enabled() { if (!publicRoadmapEnabled()) throw new AppError(404, "not_found", "Not found.") }
export async function GET() {
  try {
    enabled()
    await requirePlatformAdmin()
    return NextResponse.json(await listRoadmapItems(), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
export async function POST(request: Request) {
  try {
    enabled()
    const actor = await requirePlatformAdmin()
    assertTrustedMutation(request)
    const input = await readJson(request, roadmapItemSchema)
    return NextResponse.json(await createRoadmapItem(actor.userId, input), { status: 201 })
  } catch (error) { return apiError(error) }
}
