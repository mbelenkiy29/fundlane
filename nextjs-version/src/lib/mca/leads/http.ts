import "server-only"

import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { getWorkspaceSettings } from "../workspaces"
import { LEAD_SOURCE_KINDS } from "./contracts"

const noStore = { "cache-control": "no-store" } as const

export const leadProviderCreateSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(LEAD_SOURCE_KINDS).optional(),
}).strict()

export const leadProviderUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide a source change.")

export const purchaseBatchCreateSchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1).max(120),
  purchasedOn: z.string().nullable().optional(),
  costCents: z.number().int().nonnegative().nullable().optional(),
}).strict()

export const purchaseBatchUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  purchasedOn: z.string().nullable().optional(),
  costCents: z.number().int().nonnegative().nullable().optional(),
  inactive: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide a batch change.")

export const assignmentSchema = z.object({
  dealId: z.string().min(1),
  sourceId: z.string().min(1),
  batchId: z.string().min(1),
  correlationId: z.string().min(1).max(160),
}).strict()

export const purchasedCommitSchema = z.object({
  expectedPreviewRevision: z.number().int().positive(),
}).strict()

export async function requireLeadsActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const context = await requireWorkspaceAccess(request, {
    roles: ["admin", "super_admin"],
    sessionOnly: true,
    scopes: [mode === "read" ? "deals:read" : "deals:write"],
  })
  const settings = await getWorkspaceSettings(context.workspaceId)
  if (!settings.pageVisibility.integrations && !settings.pageVisibility.deals) {
    throw new AppError(403, "page_disabled", "Lead provider settings are disabled for this workspace.")
  }
  return { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
}

export function leadsHeaders(): { "cache-control": string } {
  return noStore
}
