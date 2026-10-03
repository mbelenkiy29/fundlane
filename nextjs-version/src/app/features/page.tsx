import { Check, ArrowRight } from "lucide-react"
import Link from "next/link"
import { MarketingShell, GetStartedLink } from "@/components/marketing/shell"
import { marketingFeatures } from "@/components/marketing/catalog"
import { FeatureVisual } from "@/components/marketing/feature-visual"
import { marketingMetadata } from "@/lib/marketing/metadata"

export const metadata = {
  ...marketingMetadata("Explore every part of your MCA workflow", "/features"),
  description: "Explore Fundlane’s pipeline, intake, underwriting, funder matching, submissions, AI assistant, closing, renewals, reporting, and team tools.",
}

export default function FeaturesPage() {
  return <MarketingShell jsonLd={{ title: "Explore every part of your MCA workflow", path: "/features", description: "Explore Fundlane’s pipeline, intake, underwriting, funder matching, submissions, AI assistant, closing, renewals, reporting, and team tools." }}><main id="main">
    <section className="fl-container fl-features-intro">
      <p className="fl-section-label">The Fundlane workspace</p>
      <h1>Every part of the deal.<br />Connected.</h1>
      <p>From the first document to the next renewal, explore the tools that keep your brokerage moving together.</p>
      <div className="fl-actions"><GetStartedLink /><Link href="/#workflow" className="fl-text-link">Follow the workflow <ArrowRight size={16} aria-hidden="true" /></Link></div>
    </section>
    <nav className="fl-container fl-feature-jumps" aria-label="Feature categories">
      {marketingFeatures.map(feature => <a href={`#${feature.id}`} key={feature.id}>{feature.title}</a>)}
    </nav>
    <div className="fl-container fl-feature-sections">
      {marketingFeatures.map(feature => {
        const Icon = feature.icon
        return <section key={feature.id} id={feature.id} className="fl-feature-section" aria-labelledby={`${feature.id}-title`}>
          <div className="fl-feature-copy">
            <p className="fl-section-label"><Icon size={18} aria-hidden="true" />{feature.title}</p>
            <h2 id={`${feature.id}-title`}>{feature.headline}</h2>
            <p>{feature.summary}</p>
            <ul className="fl-capabilities">{feature.capabilities.map(capability => <li key={capability}><Check size={16} aria-hidden="true" />{capability}</li>)}</ul>
            {feature.note && <p className="fl-feature-note">{feature.note}</p>}
            <GetStartedLink className="fl-text-link" />
          </div>
          <FeatureVisual feature={feature} />
        </section>
      })}
    </div>
    <section className="fl-closing"><div className="fl-container"><div><p className="fl-section-label">See it come together</p><h2>Your deals. Your team.<br />One clear workflow.</h2><p>Get started with a trial, or log in if you already have a workspace.</p></div><GetStartedLink /></div></section>
  </main></MarketingShell>
}
