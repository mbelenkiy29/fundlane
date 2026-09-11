import { NextResponse, after } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { getDatabase } from "@/lib/mca/db"
import { reconcileCreditPurchase } from "@/lib/mca/assistant/purchases"
import { maintainCreditAlerts } from "@/lib/mca/assistant/alerts"
import {
  assistantCreditIdentity,
  creditHeaders
} from "@/lib/mca/assistant/http"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const c = await assistantCreditIdentity(request, true)
    const b = await readJson(
      request,
      z.object({ purchaseId: z.string().uuid() }).strict()
    )
    const p = await getDatabase()
      .prepare(
        "SELECT id FROM mca_credit_purchases WHERE id=? AND workspace_id=?"
      )
      .get(b.purchaseId, c.workspaceId)
    if (!p)
      throw new AppError(
        404,
        "purchase_not_found",
        "This purchase is unavailable."
      )
    const result = await reconcileCreditPurchase(b.purchaseId)
    after(() => maintainCreditAlerts(c.workspaceId).catch(() => {}))
    return NextResponse.json(result, { headers: creditHeaders })
  } catch (error) {
    return apiError(error)
  }
}
