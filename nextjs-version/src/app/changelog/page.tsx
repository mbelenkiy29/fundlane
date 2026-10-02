import { Check } from "lucide-react"
import Image, { type StaticImageData } from "next/image"
import { MarketingShell, GetStartedLink } from "@/components/marketing/shell"
import { Timeline, type TimelineEntry } from "@/components/ui/timeline"
import { marketingMetadata } from "@/lib/marketing/metadata"
import pipeline from "../../../public/marketing/pipeline.png"
import capture from "../../../public/marketing/capture.png"
import review from "../../../public/marketing/review.png"
import submit from "../../../public/marketing/submit.png"
import offers from "../../../public/marketing/offers.png"
import renew from "../../../public/marketing/renew.png"
import reporting from "../../../public/marketing/reporting.png"
import team from "../../../public/marketing/team.png"

const CHANGELOG_DESCRIPTION =
  "See what’s new in Fundlane 1.0—pipeline, intake, underwriting, funder matching, closing, renewals, reporting, and team tools."

export const metadata = marketingMetadata("Changelog", "/changelog", CHANGELOG_DESCRIPTION)

const releaseGroups = [
  {
    title: "Pipeline and intake",
    summary: "Keep deal records, ownership, and next steps together. Bring merchant information and supporting files into the deal, and see what still needs to be collected.",
    capabilities: [
      "Follow applications through pipeline stages",
      "Collect applications through configurable forms",
      "Import spreadsheets with field mapping and review",
      "Organize documents and request missing files",
    ],
    images: [
      { src: pipeline, alt: "Fundlane pipeline with synthetic brokerage deals across application and funding stages" },
      { src: capture, alt: "Synthetic Harbor Coffee application and its required fields in Fundlane" },
    ],
  },
  {
    title: "Underwriting and funder matching",
    summary: "Review bank-statement analysis alongside the deal, then compare configured funder criteria before you prepare and send a package.",
    capabilities: [
      "Review bank-statement analysis",
      "Compare eligibility and ranked fit",
      "Review packages and preflight checks",
      "Track each destination and submission outcome",
    ],
    images: [
      { src: review, alt: "Fundlane underwriting review for an illustrative merchant application" },
      { src: submit, alt: "Fundlane submission tracking with synthetic sent, queued, and exception records" },
    ],
  },
  {
    title: "Offers, closing and renewals",
    summary: "Keep offer terms, revisions, and outstanding requirements connected to the deal, then bring funding history into the next conversation.",
    capabilities: [
      "Compare offers and track revisions",
      "Manage stipulations and merchant upload requests",
      "Track contract workflows and record funding",
      "Configure renewal eligibility thresholds",
    ],
    images: [
      { src: offers, alt: "Fundlane offers and closing with a synthetic Northside Kitchen offer and complete terms" },
      { src: renew, alt: "Fundlane renewal workspace with illustrative funding and eligibility records" },
    ],
  },
  {
    title: "Reporting and team",
    summary: "Follow commissions and payment records, then keep ownership clear with the right access for each teammate.",
    capabilities: [
      "Track commission splits and payment records",
      "Review rep funnels and team contribution",
      "Manage company roles and deal assignments",
      "Control financial visibility and team access",
    ],
    images: [
      { src: reporting, alt: "Fundlane rep performance report with synthetic records and explicit financial visibility restrictions" },
      { src: team, alt: "Fundlane team management with synthetic members and role controls" },
    ],
  },
] as const satisfies readonly {
  title: string
  summary: string
  capabilities: readonly string[]
  images: readonly { src: StaticImageData; alt: string }[]
}[]

const changelogEntries: TimelineEntry[] = [
  {
    title: "1.0",
    content: (
      <div>
        <p className="fl-changelog-meta">
          <span>Initial release</span>
          <span>September 2026</span>
        </p>
        {releaseGroups.map((group) => (
          <section key={group.title} className="fl-changelog-group">
            <h3>{group.title}</h3>
            <p>{group.summary}</p>
            <ul className="fl-capabilities">
              {group.capabilities.map((capability) => (
                <li key={capability}>
                  <Check size={16} aria-hidden="true" />
                  {capability}
                </li>
              ))}
            </ul>
            <div className="fl-changelog-grid">
              {group.images.map((image) => (
                <Image
                  key={image.src.src}
                  src={image.src}
                  alt={image.alt}
                  sizes="(max-width: 760px) 94vw, 480px"
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    ),
  },
]

export default function ChangelogPage() {
  return (
    <MarketingShell jsonLd={{ title: "Changelog", path: "/changelog", description: CHANGELOG_DESCRIPTION }}>
      <main id="main" className="fl-changelog">
        <section className="fl-container fl-changelog-intro">
          <p className="fl-section-label">Changelog</p>
          <h1>What&apos;s new in Fundlane.</h1>
          <p>The first public release of the Fundlane workspace—from intake through renewal.</p>
        </section>
        <div className="fl-container">
          <Timeline data={changelogEntries} />
        </div>
        <section className="fl-closing">
          <div className="fl-container">
            <div>
              <p className="fl-section-label">See it come together</p>
              <h2>
                Your deals. Your team.
                <br />
                One clear workflow.
              </h2>
              <p>Walk through Fundlane with your brokerage’s needs in mind.</p>
            </div>
            <GetStartedLink />
          </div>
        </section>
      </main>
    </MarketingShell>
  )
}
