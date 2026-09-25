export type HelpArticle = {
  slug: string
  title: string
  summary: string
  steps: readonly string[]
}

// Keep these instructions aligned with the signed-in screens they describe.
export const helpArticles: readonly HelpArticle[] = [
  {
    slug: "set-up-your-company",
    title: "Set up your company",
    summary: "Create or select a company workspace after signing in.",
    steps: [
      "After signing in, select an existing company or enter a name to create a new company workspace.",
      "When creating a company, continue through the billing setup screen, then invite employees and choose their roles and managers.",
      "Continue to Settings → Connections for business setup. You can finish employee invitations later in Settings → Team.",
    ],
  },
  {
    slug: "invite-a-client-to-apply",
    title: "Invite a client to apply",
    summary: "Create an application invitation and follow its progress.",
    steps: [
      "Open Applications and enter the business name and email address under Invite a client. Select a form if your company has more than one enabled form.",
      "Create the invitation, then send its email when application email delivery is enabled, or copy the client’s link to share it yourself.",
      "Use the Client invitations list to follow opens, starts, and completed submissions. An open can also come from an automated link scanner.",
    ],
  },
  {
    slug: "review-applications-and-documents",
    title: "Review applications and documents",
    summary: "Check intake progress and received files before preparing submissions.",
    steps: [
      "Open Application Intake to see incoming applications and their processing progress.",
      "Open an application review to inspect its details, document list, and funder candidates.",
      "Documents show a processing state. Preview and download controls become available when a document is ready.",
    ],
  },
  {
    slug: "track-submissions-and-offers",
    title: "Track submissions and offers",
    summary: "Find submission history and review offers for a deal.",
    steps: [
      "Open Submissions to search and filter submission records and inspect the details of a send.",
      "From a submission detail, open its deal’s submissions or offers workflow.",
      "Open Offers, choose a deal, and use the Offers and funding tab to review terms. The Closing and merchant messages tab contains the related closing workflow.",
    ],
  },
]

export function helpArticle(slug: string): HelpArticle | undefined {
  return helpArticles.find((article) => article.slug === slug)
}
