import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError, AppError } from "@/lib/mca/errors"
import { previewHistoricalImport } from "@/lib/mca/historical/service"
import { parseHistoricalSpreadsheet } from "@/lib/mca/historical/parser"
import { requireOfferActor } from "@/lib/mca/offers/http"
import { requestCorrelationId } from "@/lib/mca/http"
import { timeHistoricalPhase } from "@/lib/mca/historical/telemetry"

export const runtime = "nodejs"
const row = z.object({ externalId: z.string(), dealId: z.string().optional(), legalName: z.string().optional(), funderId: z.string().optional(), funderName: z.string(), fundedAt: z.string(), amountCents: z.number(), factorRate: z.number().optional(), termMonths: z.number().optional(), paymentAmountCents: z.number().optional(), paymentCount: z.number().optional(), paymentFrequency: z.enum(["daily", "weekly", "biweekly", "monthly"]).optional(), calendarConvention: z.enum(["calendar_days", "business_days", "fixed_count"]).optional(), commissionCents: z.number().optional(), paidCommissionCents: z.number().optional(), paidCommissionAt: z.string().optional(), feeCents: z.number().optional(), expectedCommissionAt: z.string().optional(), expectedFeeAt: z.string().optional(), splits: z.array(z.object({ recipientMembershipId: z.string(), percentageBasisPoints: z.number() })).optional(), paidSplits: z.array(z.object({ recipientMembershipId: z.string(), amountCents: z.number(), paidAt: z.string() })).optional() })
const bodySchema = z.object({ sourceId: z.string(), batchId: z.string(), requestId: z.string().trim().min(1).max(160).optional(), rows: z.array(row) })
export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request)
  try {
    const actor = { ...await timeHistoricalPhase(correlationId, "authorization", () => requireOfferActor(request, "write", { administratorSession: true })), correlationId }
    const input = await timeHistoricalPhase(correlationId, "parsing", async () => {
      if (request.headers.get("content-type")?.includes("multipart/form-data")) {
        const form = await request.formData(), file = form.get("file")
        if (!(file instanceof File)) throw new AppError(422, "historical_file_required", "Choose a historical CSV or spreadsheet.")
        return { requestId: form.has("requestId") ? String(form.get("requestId")) : undefined, sourceId: String(form.get("sourceId") ?? ""), batchId: String(form.get("batchId") ?? ""), rows: parseHistoricalSpreadsheet({ filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }) }
      }
      const parsed = bodySchema.safeParse(await request.json())
      if (!parsed.success) throw new AppError(422, "validation_failed", "Provide a valid historical import request.")
      return parsed.data
    })
    return NextResponse.json(await previewHistoricalImport(actor, input), { status: 201, headers: { "x-request-id": correlationId } })
  } catch (error) { const response = apiError(error, correlationId); response.headers.set("x-request-id", correlationId); return response }
}
