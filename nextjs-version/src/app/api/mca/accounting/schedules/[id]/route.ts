import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requirePaymentActor } from "@/lib/mca/accounting/access"
import {
  amendDistributionSchedule,
  cancelDistributionSchedule,
  exceptOccurrence,
  markInstallmentPaid,
  pauseDistributionSchedule,
} from "@/lib/mca/accounting/schedules"

export const runtime = "nodejs"

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
const schema = z.object({
  action: z.enum(["pause", "cancel", "amend", "except", "pay"]),
  startDate: calendarDate.optional(),
  installmentCount: z.number().int().positive().safe().optional(),
  installmentCents: z.number().int().positive().safe().optional(),
  splitTemplateId: z.string().min(1).optional(),
  splitTemplateVersion: z.number().int().positive().safe().optional(),
  reason: z.string().trim().max(500).optional(),
  occurrenceDate: calendarDate.optional(),
  recipientMembershipId: z.string().min(1).optional(),
  installmentId: z.string().min(1).optional(),
  paidAt: z.string().min(1).optional(),
}).strict()

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedMutation(request)
    const actor = await requirePaymentActor(request, "write")
    const scheduleId = (await context.params).id
    const input = await readJson(request, schema)
    if (input.action === "pause") return NextResponse.json(await pauseDistributionSchedule(actor, scheduleId))
    if (input.action === "cancel") return NextResponse.json(await cancelDistributionSchedule(actor, scheduleId))
    if (input.action === "amend") {
      if (!input.startDate || input.installmentCount === undefined || input.installmentCents === undefined
        || !input.splitTemplateId || input.splitTemplateVersion === undefined) {
        throw new AppError(400, "validation_failed", "Amendment requires start date, installment count, amount, and split template.")
      }
      return NextResponse.json(await amendDistributionSchedule(actor, scheduleId, {
        startDate: input.startDate,
        installmentCount: input.installmentCount,
        installmentCents: input.installmentCents,
        splitTemplateId: input.splitTemplateId,
        splitTemplateVersion: input.splitTemplateVersion,
        reason: input.reason,
      }))
    }
    if (input.action === "except") {
      if (!input.occurrenceDate) throw new AppError(400, "validation_failed", "Choose the occurrence date to except.", { occurrenceDate: ["Required"] })
      return NextResponse.json(await exceptOccurrence(actor, scheduleId, {
        occurrenceDate: input.occurrenceDate,
        recipientMembershipId: input.recipientMembershipId,
      }))
    }
    return NextResponse.json(await markInstallmentPaid(actor, scheduleId, {
      installmentId: input.installmentId,
      occurrenceDate: input.occurrenceDate,
      recipientMembershipId: input.recipientMembershipId,
      paidAt: input.paidAt,
    }))
  } catch (error) {
    return apiError(error)
  }
}
