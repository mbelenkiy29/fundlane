import { ReviewPanel } from "@/components/mca/underwriting/review-panel"

export default async function AnalysisReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return (
    <div className="px-4 lg:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Funder analysis review</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Confirm selected funders for this analysis snapshot. Signed links expire after five minutes and still require workspace access.
        </p>
      </div>
      <ReviewPanel token={token} />
    </div>
  )
}
