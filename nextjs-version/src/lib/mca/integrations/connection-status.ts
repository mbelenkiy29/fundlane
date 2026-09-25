export const CONNECTION_LABELS = [
  "Not connected",
  "Pending",
  "Expired",
  "Revoked",
  "Connected",
] as const

export type ConnectionLabel = (typeof CONNECTION_LABELS)[number]
export type IntegrationChannel = "email" | "sms" | "funder"

export type ChannelStatus = {
  channel: IntegrationChannel
  title: string
  label: ConnectionLabel
  ready: boolean
  detail: string
  href: string
}

export type OutboundGate = {
  enabled: boolean
  missing: string[]
}

export type EmailSenderStatusInput = {
  state: string
  hasCredential?: boolean
  conversationReady?: boolean
}

export type SmsAccountStatusInput = {
  state?: string
  providerConfigured?: boolean
}

export type SmsOnboardingStatusInput = {
  registrationState?: string
  platformReady?: boolean
  optOutReady?: boolean
  numbers?: unknown[]
  suspended?: boolean
}

export type FunderRouteStatusInput = {
  active: boolean
  kind: string
}

export type FunderStatusInput = {
  active?: boolean
  routes?: FunderRouteStatusInput[]
  hasApiRoute?: boolean
}

export type AdapterCredentialStatusInput = {
  hasCredential?: boolean
  active?: boolean
}

function senderReady(sender: EmailSenderStatusInput): boolean {
  return sender.conversationReady === true || (sender.state === "verified" && sender.hasCredential !== false)
}

export function emailChannelStatus(senders: EmailSenderStatusInput[]): ChannelStatus {
  const title = "Email"
  const href = "/settings/connections#email-senders"
  if (!senders.length) {
    return {
      channel: "email",
      title,
      href,
      label: "Not connected",
      ready: false,
      detail: "Not connected. Connect Gmail, Microsoft, SMTP, or SendGrid before sending email.",
    }
  }
  const readyCount = senders.filter(senderReady).length
  if (readyCount > 0) {
    return {
      channel: "email",
      title,
      href,
      label: "Connected",
      ready: true,
      detail: `${readyCount} verified sender${readyCount === 1 ? "" : "s"} ready to send.`,
    }
  }
  if (senders.every((sender) => sender.state === "revoked")) {
    return {
      channel: "email",
      title,
      href,
      label: "Revoked",
      ready: false,
      detail: "All email senders are revoked. Reconnect a sender before sending.",
    }
  }
  if (senders.some((sender) => sender.state === "expired")) {
    return {
      channel: "email",
      title,
      href,
      label: "Expired",
      ready: false,
      detail: "The email sender expired. Reconnect it to send mail.",
    }
  }
  return {
    channel: "email",
    title,
    href,
    label: "Pending",
    ready: false,
    detail: "An email sender exists but is not verified yet.",
  }
}

export function smsChannelStatus(input: {
  accounts?: SmsAccountStatusInput[]
  onboarding?: SmsOnboardingStatusInput
}): ChannelStatus {
  const title = "SMS"
  const href = "/settings/connections#company-sms"
  const accounts = input.accounts ?? []
  const readyAccount = accounts.some((account) => account.state !== "revoked" && account.providerConfigured)
  const numbers = input.onboarding?.numbers ?? []
  const onboarded = Boolean(input.onboarding?.platformReady && input.onboarding.optOutReady && numbers.length)
  if (readyAccount || onboarded) {
    return {
      channel: "sms",
      title,
      href,
      label: "Connected",
      ready: true,
      detail: readyAccount
        ? "A text account is configured and can send when consent is recorded."
        : "Company SMS has an assigned number.",
    }
  }
  if (input.onboarding?.suspended) {
    return {
      channel: "sms",
      title,
      href,
      label: "Revoked",
      ready: false,
      detail: "Company SMS is suspended.",
    }
  }
  const onboardingStarted = Boolean(
    input.onboarding?.registrationState && input.onboarding.registrationState !== "not_started",
  )
  if (accounts.length || onboardingStarted) {
    const missing: string[] = []
    if (accounts.length && !accounts.some((account) => account.providerConfigured)) {
      missing.push("provider credentials")
    }
    if (input.onboarding && !input.onboarding.platformReady) missing.push("platform Twilio setup")
    if (input.onboarding && onboardingStarted && !input.onboarding.optOutReady) missing.push("Advanced Opt-Out")
    if (input.onboarding && onboardingStarted && !numbers.length) missing.push("an assigned number")
    return {
      channel: "sms",
      title,
      href,
      label: "Pending",
      ready: false,
      detail: missing.length ? `SMS setup is incomplete: ${missing.join(", ")}.` : "SMS setup is in progress.",
    }
  }
  return {
    channel: "sms",
    title,
    href,
    label: "Not connected",
    ready: false,
    detail: "Not connected. Connect company SMS or assign a Twilio sender in Settings → Connections.",
  }
}

export function funderSubmissionChannelStatus(input: {
  funders?: FunderStatusInput[]
  credentials?: AdapterCredentialStatusInput[]
}): ChannelStatus {
  const title = "Funder submission"
  const href = "/settings/connections#funder-adapters"
  const funders = input.funders ?? []
  const credentials = input.credentials ?? []
  const activeRoutes = funders.flatMap((funder) => (funder.routes ?? []).filter((route) => route.active))
  const readyCredential = credentials.some((credential) => credential.hasCredential && credential.active !== false)
  if (activeRoutes.length || readyCredential) {
    const kinds = [...new Set(activeRoutes.map((route) => route.kind))]
    return {
      channel: "funder",
      title,
      href,
      label: "Connected",
      ready: true,
      detail: activeRoutes.length
        ? `${activeRoutes.length} active submission route${activeRoutes.length === 1 ? "" : "s"}${kinds.length ? ` (${kinds.join(", ")})` : ""}.`
        : "Funder API credentials are saved.",
    }
  }
  if (funders.length || credentials.length || funders.some((funder) => funder.hasApiRoute)) {
    return {
      channel: "funder",
      title,
      href,
      label: "Pending",
      ready: false,
      detail: "Funders exist, but none have an active submission route or saved API credential.",
    }
  }
  return {
    channel: "funder",
    title,
    href,
    label: "Not connected",
    ready: false,
    detail: "Not connected. Add a funder submission route or API credential before sending to funders.",
  }
}

export function submissionConfirmGate(input: {
  loading: boolean
  selectedIds: string[]
  funders: Array<{
    id: string
    legalName: string
    nickname?: string
    route: { kind: string; active: boolean } | null
    preflightErrors: Array<{ message: string }>
  }>
}): OutboundGate {
  if (input.loading) return { enabled: false, missing: ["Loading submission destinations…"] }
  if (!input.funders.length) {
    return { enabled: false, missing: ["No active funders are available. Add a funder route before submitting."] }
  }
  if (!input.selectedIds.length) return { enabled: false, missing: ["Select at least one funder."] }
  const missing: string[] = []
  for (const id of input.selectedIds) {
    const funder = input.funders.find((item) => item.id === id)
    const name = funder?.nickname || funder?.legalName || "Selected funder"
    if (!funder) {
      missing.push(`${name} is no longer available.`)
      continue
    }
    if (!funder.route) missing.push(`${name} has no active submission route.`)
    for (const error of funder.preflightErrors) missing.push(`${name}: ${error.message}`)
  }
  return { enabled: missing.length === 0, missing }
}

export function emailComposerGate(input: {
  loading?: boolean
  isNew: boolean
  dealId: string
  recipient?: string | null
  senders: Array<{ id: string; conversationReady?: boolean }>
  senderId: string
  subject: string
  body: string
  waiting: boolean
}): OutboundGate {
  if (input.loading) return { enabled: false, missing: ["Loading email composer…"] }
  const missing: string[] = []
  if (input.isNew) {
    if (!input.dealId) missing.push("Choose a lead or merchant.")
    if (!input.recipient) missing.push("Add an email address to this contact in the deal application.")
    if (!input.senders.some((sender) => sender.conversationReady)) {
      missing.push("Not connected. Connect Gmail or Microsoft before sending email.")
    } else if (!input.senders.find((sender) => sender.id === input.senderId)?.conversationReady) {
      missing.push("Choose a connected work email. The selected sender is not ready.")
    }
    if (!input.subject.trim()) missing.push("Enter a subject.")
  } else if (input.waiting) {
    missing.push("Waiting for the previous send to be confirmed.")
  }
  if (!input.body.trim()) missing.push("Enter a message.")
  return { enabled: missing.length === 0, missing }
}

export function reminderSendGate(input: { canSend: boolean; body: string }): OutboundGate {
  const missing: string[] = []
  if (!input.canSend) missing.push("You can preview this reminder but need deals:write to send.")
  if (!input.body.trim()) missing.push("Enter reminder text.")
  return { enabled: missing.length === 0, missing }
}

export function closingSendPreviewGate(input: { preview?: { state: string } | null }): OutboundGate {
  if (!input.preview) return { enabled: false, missing: ["Save a preview before sending."] }
  if (input.preview.state === "sent") return { enabled: false, missing: ["This preview was already sent."] }
  if (input.preview.state === "failed") {
    return { enabled: false, missing: ["This preview failed. Prepare a new preview before sending."] }
  }
  if (input.preview.state !== "preview") return { enabled: false, missing: ["This preview is not ready to send."] }
  return { enabled: true, missing: [] }
}

export function closingMerchantPreviewGate(input: {
  channel: "email" | "sms"
  emailReady: boolean
  smsReady: boolean
  smsConfigured: boolean
  smsConsent: string
}): OutboundGate {
  if (input.channel === "email") {
    return input.emailReady
      ? { enabled: true, missing: [] }
      : { enabled: false, missing: ["Choose a verified merchant sender to prepare an email preview."] }
  }
  if (!input.smsConfigured) {
    return {
      enabled: false,
      missing: ["Not connected. Ask an administrator to connect and assign a text sender in Settings → Connections."],
    }
  }
  if (input.smsConsent !== "opted_in") {
    return { enabled: false, missing: ["Record the merchant’s current opt-in evidence before preparing or sending a text."] }
  }
  return input.smsReady ? { enabled: true, missing: [] } : { enabled: false, missing: ["A ready text sender and merchant opt-in are required."] }
}

export function closingPsfDeliverGate(input: {
  revisionId: string
  amount: string
  bankName: string
  routingNumber: string
  accountNumber: string
  businessName: string
  contactName: string
  providerConnected: boolean
}): OutboundGate {
  const missing: string[] = []
  if (!input.revisionId) missing.push("Choose an offer revision.")
  if (!input.amount.trim()) missing.push("Enter the PSF amount.")
  if (!input.bankName.trim()) missing.push("Enter the bank name.")
  if (!input.routingNumber.trim()) missing.push("Enter the routing number.")
  if (!input.accountNumber.trim()) missing.push("Enter the account number.")
  if (!input.businessName.trim()) missing.push("Enter the business name.")
  if (!input.contactName.trim()) missing.push("Enter the contact name.")
  if (!input.providerConnected) missing.push("Not connected. Connect a PSF provider before delivering.")
  return { enabled: missing.length === 0, missing }
}
