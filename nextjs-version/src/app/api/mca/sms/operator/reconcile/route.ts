import { NextResponse } from "next/server"
import { z } from "zod"
import { requireWorkspaceAccess, assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { reconcileOperation } from "@/lib/mca/sms/maintenance"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireWorkspaceAccess(request, { sessionOnly: true })
    return NextResponse.json(
      await reconcileOperation(
        context,
        (await readJson(request, z.object({ id: z.string().min(1) }).strict()))
          .id
      )
    )
  } catch (e) {
    return apiError(e)
  }
}
