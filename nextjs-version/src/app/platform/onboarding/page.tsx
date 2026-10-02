import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { PlatformHeading } from "@/components/mca/platform/presentation"
import { OnboardingQueue } from "@/components/mca/platform/onboarding-queue"

export default async function OnboardingPage() {
  await requirePlatformPage()
  return <div className="min-w-0 space-y-6">
    <PlatformHeading title="Trial enrollments" description="Review retained enrollment repairs, compensation and independent service mail states." />
    <OnboardingQueue />
  </div>
}
