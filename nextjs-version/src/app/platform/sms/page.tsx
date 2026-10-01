import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import SmsReview from "@/components/mca/platform/sms-review"

export const dynamic = "force-dynamic"
export default async function SmsPage() {
  await requirePlatformPage()
  return <SmsReview />
}
