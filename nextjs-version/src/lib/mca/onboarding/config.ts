import "server-only";
import { signupMode } from "../signup-mode";
import { isStripeCheckoutTrialConfigured } from "../stripe-checkout-trial";

export const enrollmentRuntimeEnabled = (): boolean => process.env.MCA_ONBOARDING_RUNTIME_ENABLED === "true";

/** Rollback disables creation first; existing reconciliation and claim use only runtime. */
export function enrollmentCreationEnabled(): boolean {
  return enrollmentRuntimeEnabled() && process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED === "true"
    && signupMode() === "open" && isStripeCheckoutTrialConfigured();
}

export const onboardingEmailEnabled = (): boolean => enrollmentRuntimeEnabled() && process.env.MCA_ONBOARDING_EMAIL_ENABLED === "true";
