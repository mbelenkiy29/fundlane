export const SETUP_STEP_IDS = [
  "company_profile",
  "funders",
  "first_deal",
  "team",
  "integrations",
] as const

export type SetupStepId = (typeof SETUP_STEP_IDS)[number]

export interface SetupStep {
  id: SetupStepId
  title: string
  description: string
  href: string
  actionLabel: string
  complete: boolean
}

export interface WorkspaceSetup {
  dismissed: boolean
  dismissedAt: string | null
  completedCount: number
  totalCount: number
  allComplete: boolean
  nextStep: SetupStep | null
  steps: SetupStep[]
  readiness?: import("./readiness").ReadinessItem[]
  canDownloadDiagnostics?: boolean
}

export interface SetupStateInput {
  brokerageName: string
  dismissedAt: string | null
  funderCount: number
  dealCount: number
  memberCount: number
  pendingInvitationCount: number
  verifiedSenderCount: number
  enabledIntakeCount: number
  connectedDatamerchCount: number
}

export const SETUP_COPY = {
  title: "Set up your workspace",
  description: "Finish these existing items so the workspace is ready to use.",
  completeTitle: "Workspace setup is complete",
  completeDescription: "You can hide this checklist. It uses the same company, funder, deal, team, and connection status already in the app.",
  dismiss: "Hide checklist",
  dismissAria: "Hide workspace setup checklist",
  progress: (completed: number, total: number) => `${completed} of ${total} complete`,
} as const

const STEP_COPY: Record<SetupStepId, Omit<SetupStep, "id" | "complete">> = {
  company_profile: {
    title: "Company profile",
    description: "Your brokerage name is saved in workspace settings.",
    href: "/settings",
    actionLabel: "Open workspace settings",
  },
  funders: {
    title: "Add a funder",
    description: "Create a funder profile to route submissions.",
    href: "/funders",
    actionLabel: "Add a funder",
  },
  first_deal: {
    title: "Create the first deal",
    description: "Save a merchant application to open the pipeline.",
    href: "/pipeline?create=1",
    actionLabel: "Create a deal",
  },
  team: {
    title: "Invite your team",
    description: "Invite an employee so work is not limited to the owner.",
    href: "/settings/team",
    actionLabel: "Invite an employee",
  },
  integrations: {
    title: "Connect an integration",
    description: "Connect an email sender, intake form, or Data Merch using the existing connection status.",
    href: "/settings/connections",
    actionLabel: "Open connections",
  },
}

function step(id: SetupStepId, complete: boolean): SetupStep {
  return { id, complete, ...STEP_COPY[id] }
}

export function buildWorkspaceSetup(input: SetupStateInput): WorkspaceSetup {
  const steps = [
    step("company_profile", input.brokerageName.trim().length >= 2),
    step("funders", input.funderCount > 0),
    step("first_deal", input.dealCount > 0),
    step("team", input.memberCount > 1 || input.pendingInvitationCount > 0),
    step("integrations", input.verifiedSenderCount > 0 || input.enabledIntakeCount > 0 || input.connectedDatamerchCount > 0),
  ]
  const completedCount = steps.filter((item) => item.complete).length
  return {
    dismissed: Boolean(input.dismissedAt),
    dismissedAt: input.dismissedAt,
    completedCount,
    totalCount: steps.length,
    allComplete: completedCount === steps.length,
    nextStep: steps.find((item) => !item.complete) ?? null,
    steps,
  }
}
