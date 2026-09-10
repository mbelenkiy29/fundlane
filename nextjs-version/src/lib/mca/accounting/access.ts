import "server-only"

import { requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import { AppError } from "../errors"
import { isActionAllowed } from "../policy"
import { effectivePageVisibility } from "../policy"
import { getWorkspaceSettings } from "../workspaces"
import type { DealActor } from "../deals/schema"

export async function requirePaymentActor(request: Request, mode: "read" | "write", companyTotals = false): Promise<DealActor> {
  const context = await requireWorkspaceAccess(request, {
    sessionOnly: true,
    roles: ["admin", "super_admin"],
    scopes: [mode === "read" ? "deals:read" : "deals:write"],
  })
  const settings = await getWorkspaceSettings(context.workspaceId)
  const pages = context.role ? effectivePageVisibility(context.role, settings.pageVisibility, settings.featureFlags) : null
  const canViewTable = Boolean(context.role && isActionAllowed(context.role, "viewPaymentTable", settings.actionVisibility))
  const canViewTotals = Boolean(context.role && isActionAllowed(context.role, "viewCompanyFinancials", settings.actionVisibility))
  if (!pages?.payments || !canViewTable || (companyTotals && !canViewTotals)) {
    throw new AppError(403, "payment_permission_required", "Your workspace permissions do not allow access to payment records.")
  }
  return actorForDeals(context)
}

export async function canViewCompanyTotals(actor: DealActor): Promise<boolean> {
  if (!actor.role) return false
  const settings = await getWorkspaceSettings(actor.workspaceId)
  return isActionAllowed(actor.role, "viewCompanyFinancials", settings.actionVisibility)
}
