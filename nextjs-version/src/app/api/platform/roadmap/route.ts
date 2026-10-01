import { consumeRequestRateLimit } from "@/lib/mca/auth"
import { assertStrictPlatformMutation, withSuperAdminAction } from "@/lib/mca/platform-audit"
import { NextResponse } from "next/server"
import { publicRoadmapEnabled } from "@/lib/marketing/launch-switches"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { readJson } from "@/lib/mca/http"
import { createRoadmapItem, listRoadmapItems, roadmapItemSchema } from "@/lib/mca/roadmap-admin"
import { apiError, AppError } from "@/lib/mca/errors"

function enabled() { if (!publicRoadmapEnabled()) throw new AppError(404, "not_found", "Not found.") }
export async function GET(request?: Request) {
  try {
    await requireSuperAdmin(request)
    enabled()
    return NextResponse.json(await listRoadmapItems(), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
export async function POST(request: Request) {
  try {
    const actor = await requireSuperAdmin(request)
    enabled()
    assertStrictPlatformMutation(request);assertTrustedMutation(request);await consumeRequestRateLimit(`platform-mutation:${actor.userId}`,20)
    const input = await readJson(request, roadmapItemSchema)
    return NextResponse.json(await withSuperAdminAction({actor,action:"roadmap.created",targetType:"roadmap_item",request},()=>createRoadmapItem(actor.userId, input)), { status: 201, headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
