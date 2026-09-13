import {
  experienceEnabled,
  filesEnabled,
  webEnabled
} from "@/lib/mca/assistant/experience-contracts"
import {
  answerQuestion,
  beginExecution,
  endExecution,
  runMeta
} from "@/lib/mca/assistant/experience"
import { validateAttachments } from "@/lib/mca/assistant/files"
import { AppError } from "@/lib/mca/errors"
import { finishRun } from "@/lib/mca/assistant/repository"
import { NextResponse, after } from "next/server"
import { maintainCreditAlerts } from "@/lib/mca/assistant/alerts"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import {
  assistantCommand,
  type AssistantEvent
} from "@/lib/mca/assistant/contracts"
import {
  assistantAvailable,
  requireAssistantProvider,
  runDealAgent
} from "@/lib/mca/assistant/agent"
import { authorize } from "@/lib/mca/assistant/operations"
import {
  cancelConversation,
  conversationView,
  createRun,
  decideApproval,
  getRun,
  ownedConversation
} from "@/lib/mca/assistant/repository"

export const runtime = "nodejs"
export const maxDuration = 300
const headers = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await authorize(request)
    const id = new URL(request.url).searchParams.get("conversationId")
    if (!id)
      return NextResponse.json(
        {
          enabled: assistantAvailable(),
          experience: experienceEnabled(),
          web: webEnabled(),
          files: filesEnabled(),
          configured: Boolean(
            process.env.OPENAI_API_KEY && process.env.MCA_ASSISTANT_MODEL
          )
        },
        { headers }
      )
    const c = await ownedConversation(actor, id)
    await authorize(request, c.deal_id)
    return NextResponse.json(await conversationView(c), { headers })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const command = await readJson(request, assistantCommand)
    const actor = await authorize(request)
    const c = await ownedConversation(actor, command.conversationId)
    await authorize(request, c.deal_id)
    if (command.action === "cancel") {
      await cancelConversation(c)
      return NextResponse.json(await conversationView(c), { headers })
    }
    if (command.action === "answer" && !experienceEnabled())
      throw new AppError(
        404,
        "experience_disabled",
        "Conversational features are unavailable."
      )
    if (command.action === "message" && command.attachmentIds?.length) {
      if (!filesEnabled())
        throw new AppError(
          503,
          "files_disabled",
          "File processing is unavailable."
        )
      await validateAttachments(actor, c, command.attachmentIds)
    }
    requireAssistantProvider()
    await consumeRequestRateLimit(
      `assistant:user:${actor.workspaceId}:${actor.userId}`,
      12
    )
    await consumeRequestRateLimit(
      `assistant:workspace:${actor.workspaceId}`,
      60
    )
    const run =
      command.action === "message"
        ? await createRun(
            c,
            command.requestId,
            command.message,
            command.attachmentIds
          )
        : command.action === "answer"
          ? await answerQuestion(
              c,
              command.questionId,
              command.requestId,
              command.answers
            )
          : await decideApproval(c, command.approvalId, command.approve)
    after(() => maintainCreditAlerts(c.workspace_id).catch(() => {}))
    const meta = experienceEnabled() ? await runMeta(run.id) : undefined
    let remaining = 175_000
    if (meta) {
      try {
        remaining = await beginExecution(run.id)
      } catch (error) {
        await finishRun(
          c,
          run.id,
          "failed",
          undefined,
          "This request reached its execution limit."
        )
        throw error
      }
    }
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    request.signal.addEventListener("abort", onAbort, { once: true })
    if (request.signal.aborted) abort.abort()
    const deadline = setTimeout(() => abort.abort(), Math.min(remaining, 270_000))
    const watch = setInterval(() => {
      void getRun(run.id)
        .then((r) => {
          if (r.status !== "running") abort.abort()
        })
        .catch(() => abort.abort())
    }, 1500)
    const encoder = new TextEncoder()
    let closed = false
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: AssistantEvent) => {
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
            } catch {
              closed = true
              abort.abort()
            }
          }
        }
        try {
          await runDealAgent(
            {
              conversation: c,
              runId: run.id,
              request,
              signal: abort.signal,
              progress: (text) => emit({ type: "progress", text })
            },
            run,
            emit,
            command.action === "decision"
              ? { approvalId: command.approvalId, approve: command.approve }
              : command.action === "answer"
                ? { questionId: command.questionId }
                : undefined
          )
        } finally {
          clearTimeout(deadline)
          clearInterval(watch)
          request.signal.removeEventListener("abort", onAbort)
          try {
            if (meta) await endExecution(run.id)
          } finally {
            if (!closed) {
              closed = true
              controller.close()
            }
          }
        }
      },
      cancel() {
        closed = true
        abort.abort()
      }
    })
    return new Response(body, {
      headers: {
        ...headers,
        "Content-Type": "application/x-ndjson",
        "X-Accel-Buffering": "no"
      }
    })
  } catch (error) {
    return apiError(error)
  }
}
