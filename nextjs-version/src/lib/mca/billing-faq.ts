import faqs from "@/app/(dashboard)/pricing/data/faqs.json"
import { stripeTrialLifecycleEnabled } from "./billing-flags"
import { trialRequiresCard } from "./stripe-checkout-trial"

export type PricingFaq = {
  id: number
  question: string
  answer: string
}

/** Static FAQ JSON is the legacy wording. Overlay the card disclosure when the gate requires it. */
export function pricingFaqCopy(cardRequiredTrial: boolean, trialDays: number): PricingFaq[] {
  cardRequiredTrial ||= trialRequiresCard()
  return (faqs as PricingFaq[]).map(item => {
    if (item.question === "Is there a free trial available?") {
      return {
        ...item,
        answer: cardRequiredTrial
          ? stripeTrialLifecycleEnabled()
            ? `Yes. Enter a card at Stripe Checkout to start a ${trialDays}-day trial. The plan and post-trial price shown at Checkout determine what Stripe automatically charges for your licensed seats when the trial ends, unless you cancel before then in Plans & Billing or the Stripe billing portal.`
            : `Yes. Enter a card at Stripe Checkout to start a ${trialDays}-day trial. Stripe automatically charges for your licensed seats when the trial ends unless you cancel before then in Plans & Billing or the Stripe billing portal.`
          : item.answer,
      }
    }
    if (item.question === "Can I cancel my subscription anytime?") {
      return {
        ...item,
        answer: cardRequiredTrial
          ? `Yes. Cancel in Plans & Billing or the Stripe billing portal before the ${trialDays}-day trial ends to avoid the first charge. After the trial, cancellation takes effect at the end of the current billing period.`
          : item.answer,
      }
    }
    return item
  })
}
