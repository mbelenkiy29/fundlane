import Link from "next/link"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import SmsReview from "@/components/mca/platform/sms-review"
import { OperationsQueues } from "@/components/mca/platform/operations-queues"

export const dynamic = "force-dynamic"
export default async function SmsPage({searchParams=Promise.resolve({})}:{searchParams?:Promise<{view?:string}>}={}) {
  await requirePlatformPage()
  const {view}=await searchParams
  if(view==="review") return <div className="space-y-6"><Link className="underline" href="/platform/sms">Back to SMS inventory</Link><SmsReview/></div>
  return <div className="min-w-0 space-y-6"><header><h1 className="text-3xl font-bold">SMS operations</h1><p className="mt-2 text-muted-foreground">Review status and registration metadata without opening business profiles.</p></header><OperationsQueues kind="sms"/><Link className="underline" href="/platform/sms?view=review">Review submitted business details</Link></div>
}
