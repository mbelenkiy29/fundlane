import type { MetadataRoute } from "next"
import { MARKETING_ORIGIN } from "@/lib/marketing/metadata"
import { publicPricingEnabled } from "@/lib/marketing/launch-switches"
import { legalDraftPagesEnabled } from "@/lib/marketing/legal-draft-flag"

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: ["/$", "/demo$", "/features$", ...(publicPricingEnabled() ? ["/pricing$"] : []), "/changelog$", "/help", ...(legalDraftPagesEnabled() ? ["/terms$", "/privacy$"] : []), "/marketing/", "/_next/"], disallow: "/" }, sitemap: `${MARKETING_ORIGIN}/sitemap.xml` }
}
