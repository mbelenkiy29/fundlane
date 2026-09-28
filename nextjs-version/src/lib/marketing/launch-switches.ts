import { signupMode } from "@/lib/mca/signup-mode"

export function publicPricingEnabled(): boolean {
  return process.env.MCA_PUBLIC_PRICING_ENABLED === "true"
}

export function publicRoadmapEnabled(): boolean {
  return process.env.MCA_PUBLIC_ROADMAP_ENABLED === "true"
}

export function marketingTrialCtaEnabled(): boolean {
  return process.env.MCA_MARKETING_TRIAL_CTA_ENABLED === "true" && signupMode() === "open"
}
