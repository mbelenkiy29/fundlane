import type { Model } from "@openai/agents"
import type { Activity, AssistantFile, Citation } from "./experience-contracts"
import "server-only"
import { z } from "zod"
import { requireWorkspaceAccess } from "../auth"
import {
  actorForDeals,
  getDeal,
  addDealNote,
  listDeals,
  createDeal,
  updateDealRecord
} from "../deals/service"
import type { DealActor } from "../deals/schema"
import { listDocuments } from "../documents/service"
import { getWorkspaceSettings } from "../workspaces"
import { checkCompleteness } from "../underwriting/completeness"
import {
  analyzeDealStatements,
  getDealStatementUnderwriting
} from "../underwriting/statements"
import { getDealAnalysis, runAnalysis } from "../underwriting/analysis"
import {
  getSubmissionSelection,
  confirmSubmissions
} from "../submissions/queue"
import { prepareDealSubmission, readDealSubmissionPreview } from "../submissions/broker-preview"
import {
  getSmsComposerContext,
  previewDirectSms,
  deliverClosingSms,
  resolveSmsRoute
} from "../sms/service"
import { requireSmsActor } from "../sms/http"
import { listConversations, conversationDetail } from "../sms/inbox"
import { listReplyQueue } from "../submissions/replies"
import type { TwilioSmsTransport } from "../sms/twilio"
import {
  listFunderReminders,
  previewFunderReminder,
  sendFunderReminder,
  requireReminderActor
} from "../comms/reminders"
import { hashOpaqueToken } from "../crypto"
import { AppError } from "../errors"
import {
  getDatabase,
  newId,
  nowIso,
  recordAuditEvent,
  withTransaction
} from "../db"
import { canonical, type ActionKind, type ApprovalPreview } from "./contracts"
import {
  applyCalendarPlan,
  draftCalendarPlan,
  listPerformanceActions,
} from "./calendar-plan-service"
import {
  approvalForRun,
  assertRunning,
  saveApproval,
  seal,
  unseal,
  type Conversation,
  trackDeal,
  assertConversationAccess,
  getRun
} from "./repository"

export const smsInput = z
  .object({
    body: z.string().trim().min(1).max(1600),
    senderAccountId: z.string().nullable()
  })
  .strict()
export const reminderInput = z
  .object({
    jobId: z.string().min(1),
    body: z.string().trim().min(1).max(5000).nullable()
  })
  .strict()
export const submissionInput = z
  .object({ funderIds: z.array(z.string().min(1)).min(1).max(10) })
  .strict()
export const calendarPlanInput = z
  .object({ dealId: z.string().min(1).max(128).nullable() })
  .strict()
export interface OperationContext {
  conversation: Conversation
  runId: string
  request: Request
  signal: AbortSignal
  progress: (text: string) => void
  activeDealId?: string
  experience?: boolean
  model?: Model
  citations?: Citation[]
  artifacts?: AssistantFile[]
  activityEvent?: (activity: Activity) => Promise<void>
  fileEvent?: (file: AssistantFile) => Promise<void>
  smsTransport?: TwilioSmsTransport
}

export async function authorize(
  request: Request,
  dealId?: string | null
): Promise<DealActor> {
  const auth = await requireWorkspaceAccess(request, { sessionOnly: true })
  const settings = await getWorkspaceSettings(auth.workspaceId)
  if (!settings.pageVisibility.deals)
    throw new AppError(
      403,
      "page_disabled",
      "Deals are disabled for this workspace."
    )
  const actor = await actorForDeals(auth)
  if (dealId) await getDeal(actor, dealId)
  return actor
}
export async function guard(ctx: OperationContext): Promise<DealActor> {
  ctx.signal.throwIfAborted()
  if (ctx.experience && process.env.MCA_ASSISTANT_EXPERIENCE_ENABLED !== "true")
    throw new AppError(
      409,
      "experience_disabled",
      "Conversational features have been disabled."
    )
  if (process.env.MCA_ASSISTANT_ENABLED !== "true")
    throw new AppError(
      409,
      "assistant_disabled",
      "The assistant has been disabled."
    )
  await assertRunning(ctx.runId)
  const run = await getRun(ctx.runId)
  if (run.selected_deal_id) ctx.activeDealId = run.selected_deal_id
  const actor = await authorize(ctx.request, ctx.conversation.deal_id)
  if (
    actor.workspaceId !== ctx.conversation.workspace_id ||
    actor.userId !== ctx.conversation.user_id
  )
    throw new AppError(
      403,
      "identity_changed",
      "The active user or workspace changed."
    )
  await assertConversationAccess(actor, ctx.conversation)
  if (ctx.experience)
    await (await import("./experience")).assertNotDeleted(ctx.conversation)
  if (ctx.activeDealId) await getDeal(actor, ctx.activeDealId)
  return actor
}
export async function recorded<T>(
  ctx: OperationContext,
  name: string,
  operation: (actor: DealActor) => Promise<T>
): Promise<T> {
  const actor = await guard(ctx)
  const id = newId()
  ctx.progress(name.replaceAll("_", " "))
  const activity: Activity = {
    id,
    runId: ctx.runId,
    sequence: 0,
    label: name.replaceAll("_", " "),
    kind: name.includes("research")
      ? "research"
      : name.includes("file")
        ? "file"
        : "tool",
    status: "running",
    startedAt: nowIso()
  }
  await ctx.activityEvent?.(activity)
  await getDatabase()
    .prepare(
      "INSERT INTO mca_assistant_executions (id,run_id,tool_name,status,created_at) VALUES (?,?,?,'running',?)"
    )
    .run(id, ctx.runId, name, nowIso())
  try {
    const result = await operation(actor)
    await getDatabase()
      .prepare(
        "UPDATE mca_assistant_executions SET status='completed',result_cipher=?,completed_at=? WHERE id=?"
      )
      .run(seal(actor.workspaceId, result), nowIso(), id)
    await guard(ctx)
    await ctx.activityEvent?.({
      ...activity,
      status: "completed",
      completedAt: nowIso()
    })
    const rendered = JSON.stringify(result)
    return (
      rendered && rendered.length > 24000
        ? {
            truncated: true,
            content: rendered.slice(0, 24000),
            instruction:
              "Narrow the query or open the linked record for complete data."
          }
        : result
    ) as T
  } catch (error) {
    await ctx
      .activityEvent?.({
        ...activity,
        status: ctx.signal.aborted ? "cancelled" : "failed",
        completedAt: nowIso()
      })
      .catch(() => {})
    await getDatabase()
      .prepare(
        "UPDATE mca_assistant_executions SET status='failed',completed_at=? WHERE id=?"
      )
      .run(nowIso(), id)
    throw error
  }
}

/** Explicit projections keep identity numbers, credentials and raw document bytes out of chat. */
export async function readDeal(actor: DealActor, dealId: string) {
  const d = await getDeal(actor, dealId)
  return {
    id: d.id,
    displayId: d.displayId,
    legalName: d.legalName,
    dbaName: d.dbaName,
    status: d.status,
    version: d.version,
    industry: d.industry,
    monthlyRevenue: d.monthlyRevenue,
    requestedAmount: d.requestedAmount,
    fundingPurpose: d.fundingPurpose,
    notes: d.notes
      .slice(-20)
      .map((n) => ({ body: n.body, createdAt: n.createdAt })),
    link: `/deals?deal=${encodeURIComponent(dealId)}`
  }
}
export const reads = {
  deal: readDeal,
  documents: async (actor: DealActor, id: string) =>
    (await listDocuments(actor, id)).map((d) => ({
      id: d.id,
      filename: d.displayFilename,
      category: d.category,
      state: d.processingState,
      version: d.version
    })),
  underwriting: getDealStatementUnderwriting,
  matches: getDealAnalysis,
  submissions: getSubmissionSelection,
  messages: async (actor: DealActor, id: string) => ({
    sms: (await getSmsComposerContext(actor, id)).messages.map((m) => ({
      body: m.body,
      state: m.state,
      createdAt: m.createdAt
    })),
    reminders: await listFunderReminders(actor, id),
    conversations: await Promise.all(
      (await listConversations(actor, id)).conversations
        .slice(0, 10)
        .map(async (c) => ({
          id: c.id,
          messages: (await conversationDetail(actor, c.id)).messages
            .slice(-30)
            .map((m) => ({
              direction: m.direction,
              body: m.body,
              state: m.state,
              createdAt: m.createdAt
            }))
        }))
    ),
    funderReplies: (await listReplyQueue(actor, id)).replies
      .slice(0, 30)
      .map((r) => ({
        id: r.id,
        subject: r.subject,
        body: r.bodyPreview ?? r.body,
        state: r.state,
        jobId: r.matchedJobId,
        createdAt: r.createdAt
      }))
  })
}
export async function internalAction(
  ctx: OperationContext,
  action:
    | "check_documents"
    | "analyze_statements"
    | "analyze_matches"
    | "save_note",
  body?: string
) {
  return recorded(ctx, action, async (actor) => {
    const id = currentDealId(ctx)
    await claimMutation(ctx, id)
    if (action === "check_documents") return checkCompleteness(actor, id)
    if (action === "analyze_statements")
      return analyzeDealStatements(actor, id, {
        beforeStep: async () => {
          await guard(ctx)
        }
      })
    if (action === "analyze_matches")
      return runAnalysis(actor, id, { mode: "analyze_only", trigger: "manual" })
    const deal = await getDeal(actor, id)
    await addDealNote(actor, id, {
      body: z.string().trim().min(1).max(5000).parse(body),
      expectedVersion: deal.version
    })
    return { saved: true }
  })
}

export async function buildPreview(
  actor: DealActor,
  dealId: string,
  kind: ActionKind,
  input: unknown,
  submissionApproval?: { previewId: unknown }
): Promise<{
  payload: unknown
  preview: ApprovalPreview
  fingerprint: string
}> {
  const detail = (label: string, value: unknown) => ({
    label,
    value: typeof value === "string" ? value : canonical(value)
  })
  let payload: unknown, preview: ApprovalPreview, evidence: unknown
  if (kind === "sms") {
    const args = smsInput.parse(input),
      context = await getSmsComposerContext(actor, dealId)
    if (!context.recipient)
      throw new AppError(
        422,
        "recipient_missing",
        "Add a merchant phone number before preparing a text."
      )
    const p = await previewDirectSms(actor, {
      dealId,
      recipient: context.recipient,
      body: args.body,
      senderAccountId: args.senderAccountId ?? undefined
    })
    const route = await resolveSmsRoute(actor, {
      dealId,
      senderAccountId: p.accountId
    })
    payload = { ...args, senderAccountId: p.accountId }
    preview = {
      title: "Send merchant text",
      details: [
        detail("To", p.recipient),
        detail("From", route.senderIdentity),
        detail("Message", p.body)
      ],
      blocked: p.block?.message
    }
    evidence = { preview, accountId: p.accountId, consent: p.consentState }
  } else if (kind === "reminder") {
    const args = reminderInput.parse(input)
    // Bind job selection to this deal before the service can create a reminder preview.
    const selection = await getSubmissionSelection(actor, dealId)
    if (!selection.jobs.some((j) => j.jobId === args.jobId))
      throw new AppError(
        404,
        "job_not_found",
        "Choose a submission from this deal."
      )
    const p = await previewFunderReminder(actor, { jobId: args.jobId })
    payload = { ...args, reminderId: p.reminderId }
    preview = {
      title: `Remind ${p.displayFunderName}`,
      details: [
        detail("To", p.to.join(", ")),
        detail("Cc", p.cc.join(", ")),
        detail("From", `${p.sender.fromName} <${p.sender.fromAddress}>`),
        detail("Reply to", p.replyTo),
        detail("Subject", p.subject),
        detail("Message", args.body ?? p.body)
      ],
      blocked: p.canSend ? undefined : "You cannot send funder reminders."
    }
    evidence = { preview, thread: p.thread, senderId: p.sender.id }
  } else {
    const args = submissionInput.parse(input)
    const funderIds = [...new Set(args.funderIds)].sort()
    const durable = submissionApproval
      ? await readDealSubmissionPreview(actor,dealId,submissionApproval.previewId)
      : await prepareDealSubmission(actor,dealId,funderIds)
    if (canonical(durable.destinations.map(d=>d.funderId).sort())!==canonical(funderIds)) throw new AppError(409,"submission_preview_stale","The selected funders changed. Prepare a new preview.")
    payload = {funderIds,previewId:durable.id}
    preview = {
      title:"Submit deal to selected funders",
      details:[detail("Funders",durable.destinations.map(d=>d.name).join(", ")),
        ...durable.destinations.flatMap(d=>[
          detail(`${d.name} — Destination`,d.destination),
          detail("Documents",d.documents.map(doc=>`${doc.filename} (${doc.checksum})`).join("\n")),
          ...(d.email ? [detail(`${d.name} — To`,d.email.to.join(", ")),detail("Cc",d.email.cc.join(", ")),detail("From",d.email.from),detail("Reply to",d.email.replyTo),detail("Subject",d.email.subject),detail("Message",d.email.body)] : [])
        ])],
      blocked:durable.destinations.some(d=>d.errors.length) ? "Some selected funders failed submission preflight. Review the Submissions tab." : undefined
    }
    evidence={preview,destinations:durable.destinations}

  }
  return { payload, preview, fingerprint: hashOpaqueToken(canonical(evidence)) }
}

async function calendarPlanPreview(
  actor: DealActor,
  dealId: string | null
): Promise<{
  payload: { dealId: string | null; items: Awaited<ReturnType<typeof draftCalendarPlan>>["items"] }
  preview: ApprovalPreview
  fingerprint: string
}> {
  const draft = await draftCalendarPlan(actor, { dealId })
  const preview: ApprovalPreview = {
    title: draft.items.length
      ? `Add ${draft.items.length} follow-up${draft.items.length === 1 ? "" : "s"} to your calendar`
      : "Add follow-ups to your calendar",
    details: draft.items.length
      ? draft.items.map((item) => ({
          label: item.title,
          value: `${item.start} · ${item.kind}`
        }))
      : [{ label: "Items", value: "None" }],
    blocked: draft.items.length
      ? undefined
      : "There are no new follow-ups to add. Existing calendar items already cover these deals."
  }
  const payload = { dealId, items: draft.items }
  return {
    payload,
    preview,
    fingerprint: hashOpaqueToken(
      canonical({ markers: draft.items.map((item) => item.marker).sort() })
    )
  }
}

export async function prepareAction(
  ctx: OperationContext,
  kind: ActionKind,
  input: unknown
) {
  return recorded(ctx, `prepare_${kind}`, async (actor) => {
    if (kind === "sms") await requireSmsActor(ctx.request, { mode: "write" })
    if (kind === "reminder") await requireReminderActor(ctx.request, "write")
    await claimMutation(ctx, currentDealId(ctx))
    const result = await buildPreview(actor, currentDealId(ctx), kind, input)
    if (result.preview.blocked)
      return { blocked: result.preview.blocked, draft: result.preview }
    const attempted = await getDatabase()
      .prepare(
        `SELECT a.id FROM mca_assistant_approvals a JOIN mca_assistant_runs r ON r.id=a.run_id
      WHERE r.conversation_id=? AND a.fingerprint=? AND a.status IN ('executing','uncertain','executed') LIMIT 1`
      )
      .get(ctx.conversation.id, result.fingerprint)
    if (attempted)
      return {
        blocked:
          "An identical action was already attempted. Review its delivery record; use the normal messaging workflow for an intentional repeat."
      }
    const approvalId = await saveApproval(
      ctx.conversation,
      ctx.runId,
      kind,
      result.payload,
      result.preview,
      result.fingerprint
    )
    return {
      approvalId,
      preview: result.preview,
      next: "Call execute_approved_action to request user confirmation. This has not been sent."
    }
  })
}

export async function assistantPerformanceActions(
  ctx: OperationContext,
  dealId?: string | null
) {
  return recorded(ctx, "list_performance_actions", async (actor) => {
    const scoped = dealId ?? ctx.activeDealId ?? ctx.conversation.deal_id ?? null
    return listPerformanceActions(actor, scoped)
  })
}

export async function prepareCalendarPlan(
  ctx: OperationContext,
  input: { dealId?: string | null }
) {
  return recorded(ctx, "prepare_calendar_plan", async (actor) => {
    if (!actor.membershipId)
      throw new AppError(
        403,
        "assignee_forbidden",
        "Choose an authorized active assignee."
      )
    const scoped =
      input.dealId ?? ctx.activeDealId ?? ctx.conversation.deal_id ?? null
    await claimMutation(ctx, scoped ?? "$calendar_plan")
    const result = await calendarPlanPreview(actor, scoped)
    if (result.preview.blocked)
      return { blocked: result.preview.blocked, draft: result.preview }
    const attempted = await getDatabase()
      .prepare(
        `SELECT a.id FROM mca_assistant_approvals a JOIN mca_assistant_runs r ON r.id=a.run_id
      WHERE r.conversation_id=? AND a.fingerprint=? AND a.status IN ('executing','uncertain','executed') LIMIT 1`
      )
      .get(ctx.conversation.id, result.fingerprint)
    if (attempted)
      return {
        blocked:
          "An identical calendar plan was already attempted. Review the calendar before preparing another."
      }
    const approvalId = await saveApproval(
      ctx.conversation,
      ctx.runId,
      "calendar_plan",
      result.payload,
      result.preview,
      result.fingerprint
    )
    return {
      approvalId,
      preview: result.preview,
      next: "Call execute_approved_action to request user confirmation. Nothing has been added to the calendar."
    }
  })
}
export async function executeAction(ctx: OperationContext, approvalId: string) {
  return recorded(ctx, "execute_approved_action", async (actor) => {
    const stored = await approvalForRun(ctx.runId, approvalId)
    const run = await getRun(ctx.runId)
    if (run.mutation_deal_id && !run.mutation_deal_id.startsWith("$")) {
      ctx.activeDealId = run.mutation_deal_id
      await getDeal(actor, ctx.activeDealId)
      await getDatabase()
        .prepare("UPDATE mca_assistant_runs SET selected_deal_id=? WHERE id=?")
        .run(ctx.activeDealId, ctx.runId)
    }
    await claimMutation(
      ctx,
      stored.kind === "calendar_plan"
        ? run.mutation_deal_id ?? "$calendar_plan"
        : currentDealId(ctx)
    )
    if (stored.status !== "approved")
      throw new AppError(
        409,
        "approval_required",
        "This action has not been approved, or was already attempted. Review its saved outcome."
      )
    if (stored.kind === "sms")
      await requireSmsActor(ctx.request, { mode: "write" })
    if (stored.kind === "reminder")
      await requireReminderActor(ctx.request, "write")
    const original = unseal<Record<string, unknown>>(
      actor.workspaceId,
      stored.payload_cipher
    )
    const input =
      stored.kind === "reminder"
        ? { jobId: original.jobId, body: original.body }
        : stored.kind === "submissions" ? {funderIds:original.funderIds} : original
    let fresh: Awaited<ReturnType<typeof buildPreview>>
    try {
    fresh =
      stored.kind === "calendar_plan"
        ? await calendarPlanPreview(
            actor,
            typeof original.dealId === "string" || original.dealId === null
              ? (original.dealId as string | null)
              : null
          )
        : await buildPreview(
            actor,
            currentDealId(ctx),
            stored.kind,
            input,
            stored.kind === "submissions" ? {previewId:original.previewId} : undefined
          )
    } catch(error) {
      if (stored.kind === "submissions") await getDatabase().prepare("UPDATE mca_assistant_approvals SET status='stale' WHERE id=? AND status='approved'").run(approvalId)
      throw error
    }
    if (fresh.preview.blocked || fresh.fingerprint !== stored.fingerprint) {
      await getDatabase()
        .prepare(
          "UPDATE mca_assistant_approvals SET status='stale' WHERE id=? AND status='approved'"
        )
        .run(approvalId)
      throw new AppError(
        409,
        "preview_changed",
        "The recipient, contents, documents, or delivery conditions changed. Prepare a new preview."
      )
    }
    await guard(ctx)
    await withTransaction(async (db) => {
      await db
        .prepare("SELECT id FROM mca_assistant_runs WHERE id=? FOR UPDATE")
        .get(ctx.runId)
      await assertRunning(ctx.runId)
      const claimed = await db
        .prepare(
          "UPDATE mca_assistant_approvals SET status='executing' WHERE id=? AND run_id=? AND status='approved'"
        )
        .run(approvalId, ctx.runId)
      if (!claimed.changes)
        throw new AppError(
          409,
          "action_already_attempted",
          "This action has already been attempted."
        )
    })
    let result: unknown
    try {
      if (stored.kind === "sms") {
        const args = smsInput.parse(original),
          context = await getSmsComposerContext(actor, currentDealId(ctx))
        result = await deliverClosingSms(
          actor,
          {
            dealId: currentDealId(ctx),
            recipient: context.recipient!,
            body: args.body,
            senderAccountId: args.senderAccountId ?? undefined,
            idempotencyKey: approvalId,
            correlationId: `${ctx.runId}:${approvalId}`,
            payloadHash: hashOpaqueToken(args.body),
            deliveryMode: "never_attempted"
          },
          ctx.smsTransport
        )
      } else if (stored.kind === "reminder") {
        const args = reminderInput.parse(input)
        result = await sendFunderReminder(actor, {
          jobId: args.jobId,
          body: args.body ?? undefined,
          reminderId: String(original.reminderId)
        })
      } else if (stored.kind === "calendar_plan") {
        const payload = original as {
          dealId: string | null
          items: Parameters<typeof applyCalendarPlan>[1]
        }
        result = await applyCalendarPlan(actor, payload.items ?? [])
        for (const event of (result as Awaited<ReturnType<typeof applyCalendarPlan>>).events) {
          await trackDeal(ctx.conversation, event.dealId)
        }
      } else
        result = await confirmSubmissions(actor, currentDealId(ctx), {
          ...submissionInput.parse({funderIds:original.funderIds}),
          confirmationKey: approvalId,
          previewId: original.previewId as string
        })
      await getDatabase()
        .prepare(
          "UPDATE mca_assistant_approvals SET status='executed',result_cipher=? WHERE id=?"
        )
        .run(seal(actor.workspaceId, result), approvalId)
      await recordAuditEvent({
        context: actor,
        action: "assistant.action_executed",
        resourceType: stored.kind === "calendar_plan" ? "calendar_activity" : "deal",
        resourceId:
          stored.kind === "calendar_plan"
            ? (typeof original.dealId === "string" && original.dealId) || ctx.runId
            : currentDealId(ctx),
        metadata: { runId: ctx.runId, approvalId, kind: stored.kind },
        correlationId: ctx.runId
      })
      return result
    } catch (error) {
      const knownPreDispatch = stored.kind === "submissions" && error instanceof AppError && ["broker_approval_required","submission_preview_stale","preview_not_found","broker_review_required"].includes(error.code)
      await getDatabase()
        .prepare(
          "UPDATE mca_assistant_approvals SET status=?,result_cipher=? WHERE id=? AND status='executing'"
        )
        .run(
          knownPreDispatch ? "stale" : "uncertain",
          seal(actor.workspaceId, {
            state: knownPreDispatch ? "not_sent" : "unknown",
            message:
              "Review the delivery or submission record before attempting again."
          }),
          approvalId
        )
      throw error
    }
  })
}

export function currentDealId(ctx: OperationContext): string {
  const id = ctx.activeDealId ?? ctx.conversation.deal_id
  if (!id)
    throw new AppError(
      422,
      "deal_required",
      "Select a deal before performing this action."
    )
  return id
}
export async function claimMutation(ctx: OperationContext, dealId: string) {
  await guard(ctx)
  await withTransaction(async (db) => {
    const r = await db
      .prepare<{
        mutation_deal_id: string | null
      }>("SELECT mutation_deal_id FROM mca_assistant_runs WHERE id=? FOR UPDATE")
      .get(ctx.runId)
    await assertRunning(ctx.runId)
    if (r?.mutation_deal_id && r.mutation_deal_id !== dealId)
      throw new AppError(
        409,
        "one_deal_per_request",
        "Changes are limited to one deal per request. Start a new request for another deal."
      )
    await db
      .prepare("UPDATE mca_assistant_runs SET mutation_deal_id=? WHERE id=?")
      .run(dealId, ctx.runId)
    if (!dealId.startsWith("$")) await trackDeal(ctx.conversation, dealId)
  })
}
export async function selectAssistantDeal(ctx: OperationContext, id: string) {
  const actor = await guard(ctx)
  if (ctx.conversation.deal_id && ctx.conversation.deal_id !== id)
    throw new AppError(
      409,
      "deal_bound",
      "This conversation belongs to another deal. Start a workspace chat to switch deals."
    )
  const result = await readDeal(actor, id)
  await trackDeal(ctx.conversation, id)
  await getDatabase()
    .prepare(
      "UPDATE mca_assistant_runs SET selected_deal_id=? WHERE id=? AND status='running'"
    )
    .run(id, ctx.runId)
  ctx.activeDealId = id
  return result
}
export async function searchAssistantDeals(
  ctx: OperationContext,
  search: string
) {
  return recorded(ctx, "search_deals", async (actor) => {
    const result = await listDeals(actor, { search })
    const matches = result.deals.slice(0, 20)
    // Aggregate pipeline facts also reference every contributing visible record.
    await getDatabase()
      .prepare(
        "INSERT INTO mca_assistant_references (id,conversation_id,deal_id) SELECT gen_random_uuid()::text,?,jsonb_array_elements_text(?::jsonb) ON CONFLICT(conversation_id,deal_id) DO NOTHING"
      )
      .run(ctx.conversation.id, JSON.stringify(result.deals.map((d) => d.id)))
    return {
      total: result.total,
      pipelineCounts: result.counts,
      limit: 20,
      description:
        "Up to 20 visible matches; select an exact deal ID before editing.",
      deals: matches.map((d) => ({
        id: d.id,
        displayId: d.displayId,
        legalName: d.legalName,
        status: d.status,
        link: `/deals?deal=${encodeURIComponent(d.id)}`
      }))
    }
  })
}
export const assistantDealFields = z
  .object({
    legalName: z.string().trim().min(1).max(200).nullable(),
    dbaName: z.string().max(200).nullable(),
    contactName: z.string().max(200).nullable(),
    contactEmail: z.string().email().nullable(),
    contactPhone: z.string().max(40).nullable(),
    industry: z.string().max(200).nullable(),
    monthlyRevenue: z.number().nonnegative().nullable(),
    requestedAmount: z.number().nonnegative().nullable(),
    fundingPurpose: z.string().max(1000).nullable()
  })
  .strict()
export async function writeAssistantDeal(
  ctx: OperationContext,
  mode: "create" | "update",
  fields: z.infer<typeof assistantDealFields>,
  expectedVersion?: number
) {
  const input = Object.fromEntries(
    Object.entries(assistantDealFields.parse(fields)).filter(
      ([, v]) => v !== null
    )
  )
  if (!Object.keys(input).length)
    throw new AppError(
      422,
      "fields_required",
      "Provide at least one business field to save."
    )
  return recorded(ctx, mode + "_deal", async (actor) => {
    if (mode === "create") {
      if (ctx.conversation.deal_id)
        throw new AppError(
          409,
          "deal_bound",
          "Create new deals from a workspace chat."
        )
      const previous = await getRun(ctx.runId)
      if (previous.mutation_deal_id && previous.mutation_deal_id !== "$create")
        throw new AppError(
          409,
          "one_deal_per_request",
          "A deal was already changed in this request."
        )
      await claimMutation(ctx, "$create")
      return withTransaction(async (db) => {
        await db
          .prepare("SELECT id FROM mca_assistant_runs WHERE id=? FOR UPDATE")
          .get(ctx.runId)
        await guard(ctx)
        const { deal } = await createDeal(actor, {
          ...input,
          idempotencyKey: `assistant:${ctx.runId}`
        })
        await db
          .prepare(
            "UPDATE mca_assistant_runs SET mutation_deal_id=?,selected_deal_id=? WHERE id=?"
          )
          .run(deal.id, deal.id, ctx.runId)
        await trackDeal(ctx.conversation, deal.id)
        ctx.activeDealId = deal.id
        return readDeal(actor, deal.id)
      })
    }
    const id = currentDealId(ctx)
    await claimMutation(ctx, id)
    if (!expectedVersion)
      throw new AppError(
        422,
        "version_required",
        "Read the deal first and supply its current version."
      )
    await updateDealRecord(actor, id, { ...input, expectedVersion })
    return readDeal(actor, id)
  })
}
