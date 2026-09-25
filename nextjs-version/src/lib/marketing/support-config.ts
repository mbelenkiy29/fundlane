import "server-only"

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null
  } catch {
    return null
  }
}

function emailAddress(value: string | undefined): string | null {
  const email = value?.trim()
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

export function getSupportConfig() {
  return {
    statusUrl: httpsUrl(process.env.NEXT_PUBLIC_STATUS_PAGE_URL),
    roadmapUrl: httpsUrl(process.env.NEXT_PUBLIC_ROADMAP_URL),
    supportEmail: emailAddress(process.env.MCA_SUPPORT_EMAIL),
  }
}
