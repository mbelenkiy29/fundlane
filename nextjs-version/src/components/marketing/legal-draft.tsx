import { legalDraftBanner, legalPlaceholders, type LegalSection } from "@/lib/marketing/legal-drafts"

export function LegalDraft({ title, sections, lastUpdated }: { title: string; sections: readonly LegalSection[]; lastUpdated?: string }) {
  return <main id="main" className="fl-container fl-legal-page">
    <div className="fl-legal-draft-banner" role="status">{legalDraftBanner}</div>
    <h1>{title}</h1>
    <p>Effective date: {legalPlaceholders.effectiveDate}{lastUpdated ? <> · Last updated: {lastUpdated}</> : null}</p>
    {sections.map(section => <section key={section.heading}>
      <h2>{section.heading}</h2>
      {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
    </section>)}
  </main>
}
