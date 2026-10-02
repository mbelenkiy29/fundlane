import { PlatformHeading } from "@/components/mca/platform/presentation"
import { notFound } from "next/navigation"
import { publicRoadmapEnabled } from "@/lib/marketing/launch-switches"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { listRoadmapItems } from "@/lib/mca/roadmap-admin"
import { RoadmapEditor } from "./roadmap-editor"

export const dynamic = "force-dynamic"
export default async function PlatformRoadmapPage() {
  if (!publicRoadmapEnabled()) notFound()
  await requirePlatformPage()
  const items = await listRoadmapItems()
  return <div className="space-y-6"><PlatformHeading snapshotAt={new Date().toISOString()} title="Roadmap" description="Manage product updates and publication status." /><RoadmapEditor initialItems={items} /></div>
}
