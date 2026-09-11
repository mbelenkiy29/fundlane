import "server-only"

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

export function getDemoConfiguration() {
  const privacyUrl = safeHttpsUrl(process.env.MCA_MARKETING_PRIVACY_URL)
  const webhookUrl = safeHttpsUrl(process.env.MCA_DEMO_WEBHOOK_URL)
  const token = process.env.MCA_DEMO_WEBHOOK_TOKEN?.trim() || null
  return {
    privacyUrl,
    webhookUrl,
    token,
    enabled: Boolean(privacyUrl && webhookUrl && token),
  }
}
