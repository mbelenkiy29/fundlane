import "server-only"

import { ZodError, type ZodType } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { getWorkspaceSettings } from "../workspaces"

export async function requireSmsActor(request: Request, options: { mode: "read" | "write"; admin?: boolean; settings?: boolean }): Promise<DealActor> {
  if (options.mode === "write") assertTrustedMutation(request)
  const context = await requireWorkspaceAccess(request, { scopes: [options.mode === "read" ? "deals:read" : "deals:write"], sessionOnly: true })
  const settings = await getWorkspaceSettings(context.workspaceId)
  if (options.settings && !settings.pageVisibility.integrations) throw new AppError(403, "page_disabled", "Integration settings are disabled for this workspace.")
  if (!options.settings && !settings.pageVisibility.deals) throw new AppError(403, "page_disabled", "Deals and merchant messaging are disabled for this workspace.")
  const actor = { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
  if (options.admin && !["admin", "super_admin"].includes(actor.role ?? "")) throw new AppError(403, "sms_admin_required", "SMS account settings require a workspace administrator.")
  return actor
}

export function parseSmsQuery<T>(schema: ZodType<T>, request: Request): T {
  try {
    return schema.parse(Object.fromEntries(new URL(request.url).searchParams.entries()))
  } catch (error) {
    if (error instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {}
      for (const issue of error.issues) {
        const key = issue.path.join(".") || "request"
        ;(fieldErrors[key] ??= []).push(issue.message)
      }
      throw new AppError(400, "validation_failed", "Review the highlighted fields.", fieldErrors)
    }
    throw error
  }
}

