import type { Metadata } from "next"

export const MARKETING_ORIGIN = "https://fundlane.io"
export const MARKETING_DESCRIPTION =
  "Bring applications, documents, underwriting, funder submissions, offers, and follow-ups into one workspace—so your team knows what needs attention next."
export const DEMO_DESCRIPTION =
  "Request a walkthrough of Fundlane, shaped around the way your team works. Follow a deal from application to renewal and review underwriting, submissions, and team tools."
/** Last meaningful marketing-content change. Used for sitemap lastmod. */
export const MARKETING_SITEMAP_LASTMOD = new Date("2026-09-25")

export function marketingMetadata(title: string, path: string, description = MARKETING_DESCRIPTION): Metadata {
  const fullTitle = `${title} | Fundlane`
  return {
    applicationName: "Fundlane",
    appleWebApp: { capable: true, title: "Fundlane", statusBarStyle: "default" },
    icons: { icon: "/marketing/icon.svg" },
    title: { absolute: fullTitle },
    description,
    metadataBase: new URL(MARKETING_ORIGIN),
    alternates: { canonical: path },
    openGraph: {
      title: fullTitle,
      description,
      url: path,
      siteName: "Fundlane",
      type: "website",
      locale: "en_US",
      images: [
        {
          url: "/marketing/social.png",
          width: 1200,
          height: 630,
          alt: "Fundlane. From application to renewal.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: ["/marketing/social.png"],
    },
  }
}

export type MarketingJsonLdNode = {
  "@type": string
  "@id"?: string
  name?: string
  url?: string
  description?: string
  logo?: string
  applicationCategory?: string
  operatingSystem?: string
  publisher?: { "@id": string }
  isPartOf?: { "@id": string }
  about?: { "@id": string }
}

export function marketingJsonLd(input: { title: string; path: string; description?: string }): {
  "@context": "https://schema.org"
  "@graph": MarketingJsonLdNode[]
} {
  const description = input.description ?? MARKETING_DESCRIPTION
  const pageUrl = new URL(input.path, MARKETING_ORIGIN).toString()
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${MARKETING_ORIGIN}/#organization`,
        name: "Fundlane",
        url: MARKETING_ORIGIN,
        logo: `${MARKETING_ORIGIN}/marketing/icon.svg`,
      },
      {
        "@type": "WebSite",
        "@id": `${MARKETING_ORIGIN}/#website`,
        name: "Fundlane",
        url: MARKETING_ORIGIN,
        publisher: { "@id": `${MARKETING_ORIGIN}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${MARKETING_ORIGIN}/#software`,
        name: "Fundlane",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: MARKETING_ORIGIN,
        description: MARKETING_DESCRIPTION,
        publisher: { "@id": `${MARKETING_ORIGIN}/#organization` },
      },
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#webpage`,
        url: pageUrl,
        name: `${input.title} | Fundlane`,
        description,
        isPartOf: { "@id": `${MARKETING_ORIGIN}/#website` },
        about: { "@id": `${MARKETING_ORIGIN}/#software` },
      },
    ],
  }
}
