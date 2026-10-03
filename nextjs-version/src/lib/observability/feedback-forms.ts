const SCREENSHOT_HINT = "If you add a screenshot, use Hide to cover merchant or banking details."

/** Sentry feedback forms behind the floating Feedback button, in menu order. `feedback_type` is the tag to filter by in Sentry. */
export const FEEDBACK_FORMS = {
  bug: {
    label: "Report an issue",
    formTitle: "Report an issue",
    submitButtonLabel: "Send report",
    messagePlaceholder: `What happened, and what did you expect? ${SCREENSHOT_HINT}`,
    successMessageText: "Thanks. Your report was sent to the Fundlane team.",
    tags: { feedback_type: "bug" },
  },
  feature_request: {
    label: "Request a feature",
    formTitle: "Request a feature",
    submitButtonLabel: "Send request",
    messagePlaceholder: `What would you like Fundlane to do, and how would it help your team? ${SCREENSHOT_HINT}`,
    successMessageText: "Thanks. Your request was sent to the Fundlane team.",
    tags: { feedback_type: "feature_request" },
  },
  improvement: {
    label: "Suggest an improvement",
    formTitle: "Suggest an improvement",
    submitButtonLabel: "Send suggestion",
    messagePlaceholder: `What could work better, and how would it help your team? ${SCREENSHOT_HINT}`,
    successMessageText: "Thanks. Your suggestion was sent to the Fundlane team.",
    tags: { feedback_type: "improvement" },
  },
} as const

export type FeedbackKind = keyof typeof FEEDBACK_FORMS

export const FEEDBACK_KINDS = Object.keys(FEEDBACK_FORMS) as FeedbackKind[]

/** Left offset that keeps the floating button just right of the sidebar, whose account menu sits in the bottom-left corner. */
export function feedbackButtonOffset({ isMobile, state }: { isMobile: boolean; state: "expanded" | "collapsed" }) {
  if (isMobile) return "1rem"
  return state === "expanded" ? "calc(var(--sidebar-width) + 1rem)" : "calc(var(--sidebar-width-icon) + 1rem)"
}
