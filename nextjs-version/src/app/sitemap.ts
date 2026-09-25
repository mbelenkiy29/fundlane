import type { MetadataRoute } from "next"
import { MARKETING_ORIGIN, MARKETING_SITEMAP_LASTMOD } from "@/lib/marketing/metadata"
import { helpArticles } from "@/lib/marketing/help"

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: MARKETING_ORIGIN, lastModified: MARKETING_SITEMAP_LASTMOD, changeFrequency: "monthly", priority: 1 },
    { url: `${MARKETING_ORIGIN}/features`, lastModified: MARKETING_SITEMAP_LASTMOD, changeFrequency: "monthly", priority: 0.9 },
    { url: `${MARKETING_ORIGIN}/changelog`, lastModified: MARKETING_SITEMAP_LASTMOD, changeFrequency: "monthly", priority: 0.8 },
    { url: `${MARKETING_ORIGIN}/demo`, lastModified: MARKETING_SITEMAP_LASTMOD, changeFrequency: "monthly", priority: 0.8 },
    { url: `${MARKETING_ORIGIN}/help`, lastModified: MARKETING_SITEMAP_LASTMOD, changeFrequency: "monthly", priority: 0.7 },
    ...helpArticles.map(({ slug }) => ({ url: `${MARKETING_ORIGIN}/help/${slug}`, lastModified: MARKETING_SITEMAP_LASTMOD, changeFrequency: "monthly" as const, priority: 0.6 })),
  ]
}
