import type { MetadataRoute } from "next"
import { MARKETING_ORIGIN } from "@/lib/marketing/metadata"

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: ["/$", "/demo$", "/features$", "/changelog$", "/help", "/marketing/", "/_next/"], disallow: "/" }, sitemap: `${MARKETING_ORIGIN}/sitemap.xml` }
}
