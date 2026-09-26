import "server-only"
import { legalDraftPagesEnabled } from "./legal-draft-flag"

function safeHttpsUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

function isDraftPrivacyUrl(value: string): boolean {
  try {
    const path = decodeURIComponent(new URL(value).pathname).replace(/\/+$/, "").replace(/\/+/g, "/")
    return path === "/privacy"
  } catch {
    // Ambiguous paths must not approve collection while this route is a draft.
    return true
  }
}

export function getDemoConfiguration() {
  const configuredPrivacyUrl = safeHttpsUrl(process.env.MCA_MARKETING_PRIVACY_URL)
  // While /privacy serves an unapproved draft, it cannot authorize demo collection.
  // Refuse this path on any host, including preview and custom domains.
  const privacyUrl = configuredPrivacyUrl && legalDraftPagesEnabled() && isDraftPrivacyUrl(configuredPrivacyUrl)
    ? null : configuredPrivacyUrl
  const webhookUrl = safeHttpsUrl(process.env.MCA_DEMO_WEBHOOK_URL)
  const token = process.env.MCA_DEMO_WEBHOOK_TOKEN?.trim() || null
  const databaseEnabled = process.env.MCA_DEMO_DB_SUBMISSIONS_ENABLED === "true"
  return {
    privacyUrl,
    webhookUrl,
    token,
    databaseEnabled,
    enabled: Boolean(privacyUrl && (databaseEnabled || (webhookUrl && token))),
  }
}
