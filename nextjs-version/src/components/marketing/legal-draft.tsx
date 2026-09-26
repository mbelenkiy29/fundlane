import { legalPlaceholders, type LegalSection } from "@/lib/marketing/legal-drafts"

export function LegalDraft({ title, sections }: { title: string; sections: readonly LegalSection[] }) {
  return <main id="main" className="fl-container fl-legal-page">
    <div className="fl-legal-draft-banner" role="status">DRAFT — pending legal review. Not yet in effect.</div>
    <h1>{title}</h1>
    <p>Last updated: {legalPlaceholders.updated}</p>
    {sections.map(section => <section key={section.heading}>
      <h2>{section.heading}</h2>
      {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
    </section>)}
  </main>
}
