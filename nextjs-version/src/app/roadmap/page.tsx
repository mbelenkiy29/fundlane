import { notFound } from "next/navigation"
import { MarketingShell } from "@/components/marketing/shell"
import { publicRoadmapEnabled } from "@/lib/marketing/launch-switches"
import { marketingMetadata } from "@/lib/marketing/metadata"
import { getPublishedRoadmap, roadmapGroups } from "@/lib/marketing/roadmap"

export const dynamic = "force-dynamic"
export const metadata = marketingMetadata("Product roadmap", "/roadmap", "See what Fundlane is planning, building, and shipping.")

export default async function RoadmapPage() {
  if (!publicRoadmapEnabled()) notFound()
  const items = await getPublishedRoadmap()
  return <MarketingShell>
    <main id="main" className="fl-container fl-help">
      <h1>Product roadmap</h1>
      {items.length === 0 ? <p>Nothing on the roadmap yet.</p> : roadmapGroups.map(group => {
        const rows = items.filter(item => item.status === group.status)
        return rows.length ? <section key={group.status} aria-label={group.title}>
          <h2>{group.title}</h2>
          <div className="fl-help-grid">{rows.map((item, index) => <article className="fl-help-card" key={`${group.status}-${index}`}><h3>{item.title}</h3><p>{item.summary}</p></article>)}</div>
        </section> : null
      })}
    </main>
  </MarketingShell>
}
