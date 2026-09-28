import { notFound } from "next/navigation"
import { publicRoadmapEnabled } from "@/lib/marketing/launch-switches"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { listRoadmapItems } from "@/lib/mca/roadmap-admin"
import { RoadmapEditor } from "./roadmap-editor"

export const dynamic = "force-dynamic"
export default async function PlatformRoadmapPage() {
  if (!publicRoadmapEnabled()) notFound()
  await requirePlatformPage()
  return <div className="space-y-6"><h1 className="text-3xl font-bold">Roadmap</h1><RoadmapEditor initialItems={await listRoadmapItems()} /></div>
}
