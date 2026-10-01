import Link from "next/link"
import { Button } from "@/components/ui/button"
import { PlatformHeading } from "@/components/mca/platform/presentation"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import SmsReview from "@/components/mca/platform/sms-review"
import { OperationsQueues } from "@/components/mca/platform/operations-queues"

export const dynamic = "force-dynamic"
export default async function SmsPage({searchParams=Promise.resolve({})}:{searchParams?:Promise<{view?:string}>}={}) {
  await requirePlatformPage()
  const {view}=await searchParams
  if(view==="review") return <div className="space-y-6"><Button asChild variant="outline" size="sm"><Link href="/platform/sms">Back to SMS inventory</Link></Button><SmsReview/></div>
  return <div className="min-w-0 space-y-6"><PlatformHeading title="SMS operations" description="Review status and registration metadata without opening business profiles."><Button asChild variant="outline"><Link href="/platform/sms?view=review">Review submitted business details</Link></Button></PlatformHeading><OperationsQueues kind="sms"/></div>
}
