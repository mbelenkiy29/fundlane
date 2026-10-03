"use client"

import { Bug, Lightbulb, MessageSquarePlus, Sparkles } from "lucide-react"
import * as Sentry from "@sentry/nextjs"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { FEEDBACK_FORMS, FEEDBACK_KINDS, feedbackButtonOffset, type FeedbackKind } from "@/lib/observability/feedback-forms"
import { browserSentryDsn } from "@/lib/observability/sentry-options"
import { ensureFeedbackIntegration } from "./session-integrations"

const ICONS = { bug: Bug, feature_request: Lightbulb, improvement: Sparkles } satisfies Record<FeedbackKind, unknown>

async function openFeedbackForm(kind: FeedbackKind) {
  ensureFeedbackIntegration()
  const feedback = Sentry.getFeedback()
  if (!feedback) return
  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    form.removeFromDom()
  }
  const { formTitle, submitButtonLabel, messagePlaceholder, successMessageText, tags } = FEEDBACK_FORMS[kind]
  const form = await feedback.createForm({ formTitle, submitButtonLabel, messagePlaceholder, successMessageText, tags, addScreenshotButtonLabel: "Add a screenshot", onFormClose: remove, onFormSubmitted: remove })
  form.appendToDom()
  form.open()
}

/**
 * Floating entry point for issue reports, feature requests and improvement ideas, sent to Sentry User Feedback.
 * It sits bottom-left, beside the sidebar: bottom-right belongs to the Browser calls widget and toasts.
 */
export function FeedbackButton({ raised = false }: { raised?: boolean }) {
  const sidebar = useSidebar()
  if (!browserSentryDsn()) return null
  // Open after the menu has closed so its focus trap does not fight the dialog.
  const open = (kind: FeedbackKind) => () => { setTimeout(() => void openFeedbackForm(kind), 0) }
  return (
    <div className={cn("fixed z-40 transition-[left] duration-200 ease-linear print:hidden", raised ? "bottom-24" : "bottom-4")} style={{ left: feedbackButtonOffset(sidebar) }} data-sentry-unmask>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="rounded-full bg-background shadow-lg" aria-label="Send feedback">
            <MessageSquarePlus className="size-4" />
            <span className="hidden sm:inline">Feedback</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-52">
          {FEEDBACK_KINDS.map((kind) => {
            const Icon = ICONS[kind]
            return <DropdownMenuItem key={kind} onSelect={open(kind)}><Icon /> {FEEDBACK_FORMS[kind].label}</DropdownMenuItem>
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
