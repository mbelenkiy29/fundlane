"use client"
import { Button } from "@/components/ui/button"
import { PlatformSection } from "@/components/mca/platform/presentation"
import { useReportBoundaryError } from "@/components/observability/use-report-boundary-error"

export default function PlatformError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useReportBoundaryError(error)
  return <div role="alert"><PlatformSection title="Platform console unavailable" description="Confirm that your account has platform access and multi-factor authentication, then retry."><div className="flex flex-wrap gap-3"><Button onClick={reset}>Retry</Button><Button asChild variant="outline"><a href="/account-security">Account security</a></Button></div></PlatformSection></div>
}
