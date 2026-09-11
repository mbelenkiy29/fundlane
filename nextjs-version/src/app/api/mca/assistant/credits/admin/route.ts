import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { getDatabase } from "@/lib/mca/db"
import { readJson } from "@/lib/mca/http"
import {
  getCreditBalance,
  creditMonth,
  resolveCreditAllowance
} from "@/lib/mca/assistant/credits"
import {
  getAlertSettings,
  saveAlertSettings,
  alertSettingsSchema
} from "@/lib/mca/assistant/alerts"
import { purchasesAvailable } from "@/lib/mca/assistant/purchases"
import {
  assistantCreditIdentity,
  creditHeaders
} from "@/lib/mca/assistant/http"
export async function GET(request: Request) {
  try {
    const c = await assistantCreditIdentity(request, true),
      allowance = await resolveCreditAllowance(c.workspaceId)
    const users = await getDatabase()
      .prepare<{
        id: string
        name: string
        email: string
      }>("SELECT DISTINCT u.id,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.status='active' ORDER BY u.name")
      .all(c.workspaceId)
    const members = []
    for (const u of users)
      members.push({
        ...u,
        consumed:
          (
            await getDatabase()
              .prepare<{
                count: number
              }>("SELECT count(*)::int count FROM mca_credit_reservations q JOIN mca_credit_accounts a ON a.id=q.account_id WHERE a.workspace_id=? AND a.user_id=? AND q.month=? AND q.state='charged'")
              .get(c.workspaceId, u.id, creditMonth())
          )?.count ?? 0,
        balance: await getCreditBalance(
          { workspace_id: c.workspaceId, user_id: u.id },
          allowance
        )
      })
    return NextResponse.json(
      {
        members,
        settings: await getAlertSettings(c.workspaceId),
        purchasesAvailable: purchasesAvailable()
      },
      { headers: creditHeaders }
    )
  } catch (error) {
    return apiError(error)
  }
}
export async function PATCH(request: Request) {
  try {
    assertTrustedMutation(request)
    const c = await assistantCreditIdentity(request, true)
    return NextResponse.json(
      await saveAlertSettings(
        c.workspaceId,
        await readJson(request, alertSettingsSchema)
      ),
      { headers: creditHeaders }
    )
  } catch (error) {
    return apiError(error)
  }
}
