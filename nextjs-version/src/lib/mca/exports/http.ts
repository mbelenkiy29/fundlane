import "server-only"

import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { readJson, requestCorrelationId } from "../http"
import type { CreateExportInput } from "./contracts"

const filtersSchema = z.object({
  search: z.string().max(200).optional(),
  statuses: z.array(z.string()).optional(),
  assignee: z.string().max(80).optional(),
  createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must use YYYY-MM-DD").optional(),
  createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must use YYYY-MM-DD").optional(),
  funder: z.string().max(200).optional(),
}).strict()

export const createExportSchema = z.object({
  kind: z.enum(["deals", "offers", "all_deals_owners", "funded_deals"]),
  filters: filtersSchema.optional(),
  correlationId: z.string().min(1).max(128),
  async: z.boolean().optional(),
}).strict()

export const mintExportSchema = z.object({
  ttlMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
}).strict()

export async function requireExportActor(request: Request, mode: "read" | "write" | "download"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const context = await requireWorkspaceAccess(request, mode === "read"
    ? { anyScopes: ["deals:read", "deals:export"] }
    : { scopes: ["deals:export"] })
  return { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
}

export async function readCreateExport(request: Request): Promise<CreateExportInput> {
  const input = await readJson(request, createExportSchema)
  return {
    kind: input.kind,
    correlationId: input.correlationId,
    async: input.async,
    filters: input.filters as CreateExportInput["filters"],
  }
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/["\\]/g, "_")}"`,
      "cache-control": "private, no-store",
    },
  })
}

export function noStoreJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } })
}

export function invalidExportId(): never {
  throw new AppError(404, "export_job_not_found", "The requested export was not found.")
}
