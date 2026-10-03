"use client"

import { Bug, Lightbulb, MessageSquarePlus } from "lucide-react"
import * as Sentry from "@sentry/nextjs"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { browserSentryDsn } from "@/lib/observability/sentry-options"
import { ensureFeedbackIntegration } from "./session-integrations"

const SCREENSHOT_HINT = "If you add a screenshot, use Hide to cover merchant or banking details."

const FORMS = {
  bug: {
    formTitle: "Report a bug",
    submitButtonLabel: "Send report",
    messagePlaceholder: `What happened, and what did you expect? ${SCREENSHOT_HINT}`,
    successMessageText: "Thanks. Your report was sent to the Fundlane team.",
    tags: { feedback_type: "bug" },
  },
  feature_request: {
    formTitle: "Request a feature",
    submitButtonLabel: "Send request",
    messagePlaceholder: `What would you like Fundlane to do, and how would it help your team? ${SCREENSHOT_HINT}`,
    successMessageText: "Thanks. Your request was sent to the Fundlane team.",
    tags: { feedback_type: "feature_request" },
  },
} as const

async function openFeedbackForm(kind: keyof typeof FORMS) {
  ensureFeedbackIntegration()
  const feedback = Sentry.getFeedback()
  if (!feedback) return
  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    form.removeFromDom()
  }
  const form = await feedback.createForm({ ...FORMS[kind], addScreenshotButtonLabel: "Add a screenshot", onFormClose: remove, onFormSubmitted: remove })
  form.appendToDom()
  form.open()
}

/** Header entry point for bug reports and feature requests, sent to Sentry User Feedback. */
export function FeedbackMenu() {
  if (!browserSentryDsn()) return null
  // Open after the menu has closed so its focus trap does not fight the dialog.
  const open = (kind: keyof typeof FORMS) => () => { setTimeout(() => void openFeedbackForm(kind), 0) }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Send feedback">
          <MessageSquarePlus className="size-4" />
          <span className="hidden md:inline">Feedback</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem onSelect={open("bug")}><Bug /> Report a bug</DropdownMenuItem>
        <DropdownMenuItem onSelect={open("feature_request")}><Lightbulb /> Request a feature</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
