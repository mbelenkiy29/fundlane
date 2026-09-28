import { NextResponse } from "next/server"
import { publicRoadmapEnabled } from "@/lib/marketing/launch-switches"
import { requirePlatformAdmin } from "@/lib/mca/platform-auth"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { readJson } from "@/lib/mca/http"
import { changeRoadmapItem, roadmapChangeSchema, roadmapEditSchema } from "@/lib/mca/roadmap-admin"
import { apiError, AppError } from "@/lib/mca/errors"

type Context = { params: Promise<{ id: string }> }
async function mutate(request: Request, context: Context, action: "update" | "publish" | "unpublish" | "delete") {
  try {
    if (!publicRoadmapEnabled()) throw new AppError(404, "not_found", "Not found.")
    const actor = await requirePlatformAdmin()
    assertTrustedMutation(request)
    const input = await readJson(request, action === "update" ? roadmapEditSchema : roadmapChangeSchema)
    const { id } = await context.params
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError(404, "not_found", "Not found.")
    return NextResponse.json(await changeRoadmapItem(id, actor.userId, input, action))
  } catch (error) { return apiError(error) }
}
export async function PUT(request: Request, context: Context) { return mutate(request, context, "update") }
export async function DELETE(request: Request, context: Context) { return mutate(request, context, "delete") }
export async function POST(request: Request, context: Context) {
  try {
    const url = new URL(request.url)
    if (url.searchParams.get("action") !== "publish" && url.searchParams.get("action") !== "unpublish") throw new AppError(404, "not_found", "Not found.")
    return mutate(request, context, url.searchParams.get("action") as "publish" | "unpublish")
  } catch (error) { return apiError(error) }
}
