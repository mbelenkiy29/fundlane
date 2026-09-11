import type { MetadataRoute } from "next"
import { MARKETING_ORIGIN } from "@/lib/marketing/metadata"

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: MARKETING_ORIGIN, changeFrequency: "monthly", priority: 1 }, { url: `${MARKETING_ORIGIN}/demo`, changeFrequency: "monthly", priority: 0.8 }]
}
