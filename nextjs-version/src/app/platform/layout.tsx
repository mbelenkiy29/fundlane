import { PlatformChrome } from "@/components/mca/platform/platform-chrome"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { publicRoadmapEnabled } from "@/lib/marketing/launch-switches"

export const dynamic = "force-dynamic"

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const actor = await requirePlatformPage()
  return <PlatformChrome userId={actor.userId} email={actor.email} roadmapEnabled={publicRoadmapEnabled()}>{children}</PlatformChrome>
}
