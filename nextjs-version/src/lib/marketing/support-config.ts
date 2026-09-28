import "server-only"
import { publicRoadmapEnabled } from "./launch-switches"

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

export function getConfiguredSupportRows(config: ReturnType<typeof getSupportConfig>) {
  const rows: { label: string; href: string; linkText: string }[] = []
  if (config.supportEmail) rows.push({ label: "Support", href: `mailto:${config.supportEmail}`, linkText: config.supportEmail })
  if (config.statusUrl) rows.push({ label: "System status", href: config.statusUrl, linkText: "View status page" })
  if (publicRoadmapEnabled()) rows.push({ label: "Roadmap", href: "/roadmap", linkText: "Roadmap" })
  else if (config.roadmapUrl) rows.push({ label: "Roadmap", href: config.roadmapUrl, linkText: "View roadmap" })
  return rows
}
