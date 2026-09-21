import { ApplicationReviewWorkspace } from "@/components/mca/intake/application-review"

export default async function ApplicationReviewPage({ params }: { params: Promise<{ intakeId: string }> }) {
  const { intakeId } = await params
  return <ApplicationReviewWorkspace key={intakeId} intakeId={intakeId} />
}
