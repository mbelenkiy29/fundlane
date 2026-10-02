import "server-only"
import { enrollmentCreationEnabled } from "@/lib/mca/onboarding/config"
import { marketingTrialCtaEnabled, publicPricingEnabled } from "./launch-switches"

/** Public purchase navigation uses the same creation gate as enrollment. */
export function marketingTrialEnrollmentEnabled(): boolean {
  return publicPricingEnabled() && marketingTrialCtaEnabled() && enrollmentCreationEnabled()
}
