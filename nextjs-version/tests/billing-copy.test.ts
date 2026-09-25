import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { renderBillingEmailContent } from "../src/lib/mca/email"
import { pricingFaqCopy } from "../src/lib/mca/billing-faq"
import { isStripeCheckoutTrialConfigured } from "../src/lib/mca/stripe-checkout-trial"
import { TRIAL_DAYS } from "../src/lib/mca/billing-catalog"

const sourceRoot = join(import.meta.dirname, "../src")
const copyPaths = [
  "app/(auth)/onboarding/page.tsx",
  "app/(dashboard)/pricing",
  "components/mca/billing-panel.tsx",
  "components/pricing-plans.tsx",
  "lib/mca/email.ts",
  "lib/mca/billing-faq.ts",
]
const stripeEnv = {
  MCA_STRIPE_BILLING_ENABLED: "true",
  MCA_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_BASE_PRICE_ID: "price_base",
  STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_fake",
}
const stripeKeys = Object.keys(stripeEnv)
const savedStripe = Object.fromEntries(stripeKeys.map(key => [key, process.env[key]]))
const obsoletePaymentClaim = /\bpaypal\b|\bbank[\s-]+transfer\b/i
const cardRequiredClaim = /\benter a card\b|\bcard required\b|\bautomatically charges\b/i
const noCardWording = /\bno[\s-]+(?:credit[\s-]+)?card\b|\bno automatic charge\b/i

function sourceFiles(path: string): string[] {
  const fullPath = join(sourceRoot, path)
  if (!statSync(fullPath, { throwIfNoEntry: false })) return []
  if (!statSync(fullPath).isDirectory()) return [path]
  return readdirSync(fullPath, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sourceFiles(join(path, entry.name)) :
      /\.(?:json|tsx?|jsx?)$/.test(entry.name) ? [join(path, entry.name)] : [],
  )
}

function restoreStripeEnv() {
  for (const key of stripeKeys) {
    if (savedStripe[key] === undefined) delete process.env[key]
    else process.env[key] = savedStripe[key]
  }
}

function clearStripeEnv() {
  for (const key of stripeKeys) delete process.env[key]
}

function configureStripeEnv() {
  Object.assign(process.env, stripeEnv)
}

function withStripeMode<T>(configured: boolean, run: () => T): T {
  const previous = Object.fromEntries(stripeKeys.map(key => [key, process.env[key]]))
  try {
    if (configured) configureStripeEnv()
    else clearStripeEnv()
    return run()
  } finally {
    for (const key of stripeKeys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function trialSurfaces() {
  const faqs = pricingFaqCopy(isStripeCheckoutTrialConfigured())
  const trialFaq = faqs.find(item => item.question === "Is there a free trial available?")?.answer
  const cancelFaq = faqs.find(item => item.question === "Can I cancel my subscription anytime?")?.answer
  const endingEmail = renderBillingEmailContent({ data: { kind: "trial_ending" }, actionUrl: "https://app.example.test/settings/billing" })
  const endedEmail = renderBillingEmailContent({ data: { kind: "trial_ended" }, actionUrl: "https://app.example.test/settings/billing" })
  return { trialFaq, cancelFaq, endingEmail, endedEmail }
}

function assertCardTrialDisclosure(copy: string) {
  assert.match(copy, /(?:\d+|\$\{(?:TRIAL_DAYS|account\.trialDays)\})-day trial/)
  assert.match(copy, /card/i)
  assert.match(copy, /automatically charges/)
  assert.match(copy, /licensed seats/)
  assert.match(copy, /cancel before then/)
  assert.match(copy, /Plans &(?:amp;)? Billing/)
  assert.match(copy, /Stripe billing portal/)
}

test("customer billing copy does not claim PayPal or bank transfer support", () => {
  const files = copyPaths.flatMap(sourceFiles)
  assert.ok(files.includes(join("app/(dashboard)/pricing", "data/faqs.json")))
  for (const path of files) {
    assert.doesNotMatch(readFileSync(join(sourceRoot, path), "utf8"), obsoletePaymentClaim, path)
  }
})

test("unconfigured Stripe keeps the no-card trial wording and does not require a card", () => {
  withStripeMode(false, () => {
    assert.equal(isStripeCheckoutTrialConfigured(), false)
    const { trialFaq, cancelFaq, endingEmail, endedEmail } = trialSurfaces()
    assert.equal(trialFaq, "Yes, all plans come with a 14-day free trial. No credit card is required to start your trial, and you can explore all features during this period.")
    assert.equal(cancelFaq, "Yes, you can cancel your subscription at any time from your account settings. You'll continue to have access to all features until the end of your current billing period.")
    assert.match(endingEmail.text, /no-card trial/)
    assert.match(endingEmail.html, /no-card trial/)
    assert.match(endedEmail.text, /Your data remains available for recovery/)
    for (const copy of [trialFaq, cancelFaq, endingEmail.text, endingEmail.html, endedEmail.text, endedEmail.html]) {
      assert.ok(copy)
      assert.doesNotMatch(copy, cardRequiredClaim)
    }
    const onboarding = readFileSync(join(sourceRoot, "app/(auth)/onboarding/page.tsx"), "utf8")
    const panel = readFileSync(join(sourceRoot, "components/mca/billing-panel.tsx"), "utf8")
    assert.match(onboarding, /Start a 14-day trial with no card\. Trial access includes up to 5 users, even if you select more paid seats\. No automatic charge; subscribe when ready\./)
    assert.match(panel, /No card required; up to 5 trial users\./)
    assert.match(panel, /Checkout activates paid access immediately and ends the no-card trial\. Seat increases are prorated and activate after payment\. Reductions apply at renewal and cannot go below active members plus pending invitations\./)
  })
})

test("configured Stripe Checkout discloses the card-required trial", () => {
  withStripeMode(true, () => {
    assert.equal(isStripeCheckoutTrialConfigured(), true)
    const { trialFaq, cancelFaq, endingEmail } = trialSurfaces()
    for (const copy of [trialFaq, endingEmail.text, endingEmail.html]) {
      assert.ok(copy)
      assertCardTrialDisclosure(copy)
      assert.doesNotMatch(copy, noCardWording)
    }
    assert.match(cancelFaq ?? "", /Plans &(?:amp;)? Billing/)
    assert.match(cancelFaq ?? "", /Stripe billing portal/)
    assert.match(cancelFaq ?? "", new RegExp(`${TRIAL_DAYS}-day trial`))
    const onboarding = readFileSync(join(sourceRoot, "app/(auth)/onboarding/page.tsx"), "utf8")
    const panel = readFileSync(join(sourceRoot, "components/mca/billing-panel.tsx"), "utf8")
    for (const copy of [onboarding, panel]) {
      assertCardTrialDisclosure(copy)
    }
  })
})

test("pricing FAQ JSON stays on the no-card answers used when Stripe is not configured", () => {
  const faq = JSON.parse(readFileSync(join(sourceRoot, "app/(dashboard)/pricing/data/faqs.json"), "utf8")) as { question: string; answer: string }[]
  assert.match(faq.find(item => item.question === "Is there a free trial available?")?.answer ?? "", /No credit card is required/)
  assert.match(faq.find(item => /payment methods/i.test(item.question))?.answer ?? "", /card/)
  assert.match(faq.find(item => /annual/i.test(item.question))?.answer ?? "", /monthly/)
})

restoreStripeEnv()
