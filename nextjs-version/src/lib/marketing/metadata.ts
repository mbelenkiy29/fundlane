import type { Metadata } from "next"

export const MARKETING_ORIGIN = "https://fundlane.io"
export const MARKETING_DESCRIPTION =
  "Bring applications, underwriting, funder submissions, offers, and commissions into one workspace—so your team knows what needs attention next."

export function marketingMetadata(title: string, path: string): Metadata {
  const fullTitle = `${title} | Fundlane`
  return {
    icons: { icon: "/marketing/icon.svg" },
    title: { absolute: fullTitle },
    description: MARKETING_DESCRIPTION,
    metadataBase: new URL(MARKETING_ORIGIN),
    alternates: { canonical: path },
    openGraph: {
      title: fullTitle,
      description: MARKETING_DESCRIPTION,
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
      description: MARKETING_DESCRIPTION,
      images: ["/marketing/social.png"],
    },
  }
}
