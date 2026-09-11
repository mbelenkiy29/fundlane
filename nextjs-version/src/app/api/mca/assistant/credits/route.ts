import { NextResponse, after } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getDatabase } from "@/lib/mca/db"
import { getCreditBalance } from "@/lib/mca/assistant/credits"
import { maintainCreditAlerts } from "@/lib/mca/assistant/alerts"
import { purchasesAvailable } from "@/lib/mca/assistant/purchases"
import {
  assistantCreditIdentity,
  creditHeaders
} from "@/lib/mca/assistant/http"
export async function GET(request: Request) {
  try {
    const c = await assistantCreditIdentity(request)
    const balance = await getCreditBalance({
      workspace_id: c.workspaceId,
      user_id: c.userId
    })
    const ledger = await getDatabase()
      .prepare(
        'SELECT l.id,l.kind,l.amount,l.source,l.created_at AS "createdAt" FROM mca_credit_ledger l JOIN mca_credit_accounts a ON a.id=l.account_id WHERE a.workspace_id=? AND a.user_id=? ORDER BY l.created_at DESC,l.id DESC LIMIT 30'
      )
      .all(c.workspaceId, c.userId)
    after(() => maintainCreditAlerts(c.workspaceId).catch(() => {}))
    return NextResponse.json(
      {
        workspaceId: c.workspaceId,
        balance,
        ledger,
        canManage: ["admin", "super_admin"].includes(c.role),
        purchasesAvailable: purchasesAvailable()
      },
      { headers: creditHeaders }
    )
  } catch (error) {
    return apiError(error)
  }
}
