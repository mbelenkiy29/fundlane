import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { renderBillingEmailContent } from "../src/lib/mca/email"
import { pricingFaqCopy } from "../src/lib/mca/billing-faq"
import { cardRequiredTrial, isStripeCheckoutTrialConfigured } from "../src/lib/mca/stripe-checkout-trial"

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
const trialEmails = ["trial_ending", "trial_ended"] as const
const trialingSuffix = " Stripe automatically charges for your licensed seats when the trial ends unless you cancel before then in Plans & Billing or the Stripe billing portal."
const localNoCardSuffix = " No card required; up to 5 trial users."
const configuredCheckout = "Checkout collects a card and starts the trial shown there for new companies. After the trial, Stripe charges for the selected seats unless you cancel before it ends in Plans & Billing or the Stripe billing portal. Trial seat changes take effect immediately; paid increases activate after payment and reductions apply at renewal."
const unconfiguredCheckout = "Checkout activates paid access immediately and ends the no-card trial. Seat increases are prorated and activate after payment. Reductions apply at renewal and cannot go below active members plus pending invitations."

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

function withStripeMode<T>(configured: boolean, run: () => T): T {
  const previous = Object.fromEntries(stripeKeys.map(key => [key, process.env[key]]))
  try {
    if (configured) Object.assign(process.env, stripeEnv)
    else for (const key of stripeKeys) delete process.env[key]
    return run()
  } finally {
    for (const key of stripeKeys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function renderTrialEmails() {
  return Object.fromEntries(trialEmails.map(kind => [kind, renderBillingEmailContent({ data: { kind }, actionUrl: "https://app.example.test/settings/billing" })])) as Record<typeof trialEmails[number], ReturnType<typeof renderBillingEmailContent>>
}

function billingPanelTrialSuffix(status: string, cardRequiredTrial?: boolean) {
  return status === "trialing" ? trialingSuffix : cardRequiredTrial ? "" : localNoCardSuffix
}

test("customer billing copy does not claim PayPal or bank transfer support", () => {
  const files = copyPaths.flatMap(sourceFiles)
  assert.ok(files.includes(join("app/(dashboard)/pricing", "data/faqs.json")))
  for (const path of files) {
    assert.doesNotMatch(readFileSync(join(sourceRoot, path), "utf8"), obsoletePaymentClaim, path)
  }
})

test("local trial emails keep their no-card wording in both checkout modes", () => {
  for (const configured of [false, true]) {
    withStripeMode(configured, () => {
      assert.equal(isStripeCheckoutTrialConfigured(), configured)
      const emails = renderTrialEmails()
      assert.match(emails.trial_ending.text, /Your no-card trial is ending soon/)
      assert.match(emails.trial_ending.html, /Your no-card trial is ending soon/)
      assert.match(emails.trial_ended.text, /Your data remains available for recovery/)
      assert.match(emails.trial_ended.html, /Your data remains available for recovery/)
      for (const email of Object.values(emails)) {
        assert.doesNotMatch(email.text, cardRequiredClaim)
        assert.doesNotMatch(email.html, cardRequiredClaim)
      }
    })
  }
})

test("unset lifecycle flag preserves the original local trial email body", () => {
  const previous=process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED
  delete process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED
  try {
    const url="https://app.example.test/settings/billing"
    const result=renderBillingEmailContent({data:{kind:"trial_ending",trialEndsAt:"2030-01-01T00:00:00Z"},actionUrl:url})
    const description="Your no-card trial is ending soon. Choose your paid seat quantity in Plans & Billing to continue. Checkout starts your paid subscription immediately."
    assert.deepEqual(result,{subject:"Your Fundlane trial ends soon",text:`${description}\n\nDeadline: 2030-01-01T00:00:00Z\n\nPlans & Billing: ${url}`,html:`<p>${description.replace("Plans & Billing","Plans &amp; Billing")}</p><p>Deadline: 2030-01-01T00:00:00Z</p><p><a href="${url}">Open Plans &amp; Billing</a></p>`})
    const queuedStripePayload=renderBillingEmailContent({data:{kind:"trial_ending",stripeTrial:true,trialEndsAt:"2030-01-01T00:00:00Z",amount:1000,quantity:1,currency:"usd"},actionUrl:url})
    assert.match(queuedStripePayload.text,/Your Stripe trial ends soon/)
    assert.match(queuedStripePayload.text,/Upcoming invoice total: \$10\.00\. Selected seats: 1/)
    assert.match(queuedStripePayload.text,/Stripe billing portal/)
    assert.doesNotMatch(queuedStripePayload.text,/Checkout starts your paid subscription immediately/)
  } finally { if(previous===undefined) delete process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED;else process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED=previous }
})

test("unconfigured Stripe keeps the no-card trial wording", () => {
  withStripeMode(false, () => {
    assert.equal(isStripeCheckoutTrialConfigured(), false)
    const faqs = pricingFaqCopy(false, 21)
    assert.equal(faqs.find(item => item.question === "Is there a free trial available?")?.answer, "Yes, all plans come with a 14-day free trial. No credit card is required to start your trial, and you can explore all features during this period.")
    assert.equal(faqs.find(item => item.question === "Can I cancel my subscription anytime?")?.answer, "Yes, you can cancel your subscription at any time from your account settings. You'll continue to have access to all features until the end of your current billing period.")
    const onboarding = readFileSync(join(sourceRoot, "app/(auth)/onboarding/page.tsx"), "utf8")
    const panel = readFileSync(join(sourceRoot, "components/mca/billing-panel.tsx"), "utf8")
    assert.match(onboarding, /Start a 14-day trial with no card\. Trial access includes up to 5 users, even if you select more paid seats\. No automatic charge; subscribe when ready\./)
    assert.ok(panel.includes(unconfiguredCheckout))
  })
})

test("configured Stripe Checkout discloses the card-required trial on onboarding and FAQ", () => {
  withStripeMode(true, () => {
    assert.equal(isStripeCheckoutTrialConfigured(), true)
    const previous = process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED
    process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED = "true"
    try {
    const faqs = pricingFaqCopy(true, 21)
    const trialFaq = faqs.find(item => item.question === "Is there a free trial available?")?.answer ?? ""
    const cancelFaq = faqs.find(item => item.question === "Can I cancel my subscription anytime?")?.answer ?? ""
    assert.match(trialFaq, /21-day trial/)
    assert.match(trialFaq, /Enter a card at Stripe Checkout/)
    assert.match(trialFaq, /automatically charges/)
    assert.match(trialFaq, /licensed seats/)
    assert.match(trialFaq, /cancel before then/)
    assert.match(trialFaq, /Plans & Billing/)
    assert.match(trialFaq, /Stripe billing portal/)
    assert.match(cancelFaq, /21-day trial/)
    assert.match(cancelFaq, /Plans & Billing/)
    assert.match(cancelFaq, /Stripe billing portal/)
    const onboarding = readFileSync(join(sourceRoot, "app/(auth)/onboarding/page.tsx"), "utf8")
    assert.match(onboarding, /Enter a card at Stripe Checkout to start a \$\{account\.trialDays\}-day trial/)
    assert.match(onboarding, /automatically charges/)
    assert.match(onboarding, /licensed seats/)
    assert.match(onboarding, /account\.trialLifecycleEnabled\?/)
    assert.match(onboarding, /post-trial price shown at Checkout/)
    assert.match(onboarding, /Stripe automatically charges for your licensed seats when the trial ends unless you cancel before then/)
    const panel = readFileSync(join(sourceRoot, "components/mca/billing-panel.tsx"), "utf8")
    assert.ok(panel.includes(configuredCheckout))
    assert.doesNotMatch(panel, /14-day trial/)
    } finally { if (previous === undefined) delete process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED; else process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED = previous }
  })
})

test("unset lifecycle flag preserves origin/main FAQ and onboarding trial disclosure", () => {
  const previous = process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED
  delete process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED
  try {
    assert.equal(pricingFaqCopy(true, 21).find(item => item.question === "Is there a free trial available?")?.answer,
      "Yes. Enter a card at Stripe Checkout to start a 21-day trial. Stripe automatically charges for your licensed seats when the trial ends unless you cancel before then in Plans & Billing or the Stripe billing portal.")
    const onboarding = readFileSync(join(sourceRoot, "app/(auth)/onboarding/page.tsx"), "utf8")
    assert.match(onboarding, /Stripe automatically charges for your licensed seats when the trial ends unless you cancel before then in Plans & Billing or the Stripe billing portal\./)
    assert.match(onboarding, /account\.trialLifecycleEnabled\?/)
  } finally { if (previous === undefined) delete process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED; else process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED = previous }
})

test("billing panel trial line follows access status", () => {
  const panel = readFileSync(join(sourceRoot, "components/mca/billing-panel.tsx"), "utf8")
  assert.match(panel, /state\.access\.status==="trialing"\?" Stripe automatically charges for your licensed seats when the trial ends unless you cancel before then in Plans & Billing or the Stripe billing portal\.":state\.cardRequiredTrial\?"":" No card required; up to 5 trial users\."/)
  assert.equal(billingPanelTrialSuffix("trialing", true), trialingSuffix)
  assert.equal(billingPanelTrialSuffix("trial", true), "")
  assert.equal(billingPanelTrialSuffix("trial", false), localNoCardSuffix)
  assert.equal(billingPanelTrialSuffix("trial"), localNoCardSuffix)
})

test("pricing FAQ JSON stays on the no-card answers used when Stripe is not configured", () => {
  const faq = JSON.parse(readFileSync(join(sourceRoot, "app/(dashboard)/pricing/data/faqs.json"), "utf8")) as { question: string; answer: string }[]
  assert.match(faq.find(item => item.question === "Is there a free trial available?")?.answer ?? "", /No credit card is required/)
  assert.match(faq.find(item => /payment methods/i.test(item.question))?.answer ?? "", /card/)
  assert.match(faq.find(item => /annual/i.test(item.question))?.answer ?? "", /monthly/)
})

test("card-required flag removes reachable no-card copy with invalid Stripe settings", () => {
  const previous=process.env.MCA_TRIAL_REQUIRES_CARD
  process.env.MCA_TRIAL_REQUIRES_CARD="true"
  try {
    withStripeMode(false, () => {
      assert.equal(isStripeCheckoutTrialConfigured(),false)
      assert.equal(cardRequiredTrial(),true)
      const faqs=pricingFaqCopy(false,14)
      assert.match(faqs.find(item=>item.id===2)?.answer??"",/Enter a card at Stripe Checkout/)
      assert.doesNotMatch(JSON.stringify(faqs),/no credit card|no card/i)
      const localEmail=renderBillingEmailContent({data:{kind:"trial_ending"},actionUrl:"https://app.example.test/settings/billing"})
      assert.match(localEmail.text,/Your existing trial is ending soon/)
      assert.doesNotMatch(localEmail.text+localEmail.html,/no.card/i)
      const onboarding=readFileSync(join(sourceRoot,"app/(auth)/onboarding/page.tsx"),"utf8")
      const panel=readFileSync(join(sourceRoot,"components/mca/billing-panel.tsx"),"utf8")
      assert.match(onboarding,/account\.cardRequiredTrial\?.*:"Start a 14-day trial with no card/)
      assert.match(panel,/state\.cardRequiredTrial\?.*:" No card required; up to 5 trial users/)
      assert.match(panel,/state\.cardRequiredTrial\?.*:"Checkout activates paid access immediately and ends the no-card trial/)
    })
  } finally {if(previous===undefined)delete process.env.MCA_TRIAL_REQUIRES_CARD;else process.env.MCA_TRIAL_REQUIRES_CARD=previous}
})

test("only the exact true flag enables the card requirement when Stripe is invalid", () => {
  const previous=process.env.MCA_TRIAL_REQUIRES_CARD
  try {
    withStripeMode(false, () => {
      for(const value of [undefined,"false","TRUE","1"]){
        if(value===undefined)delete process.env.MCA_TRIAL_REQUIRES_CARD
        else process.env.MCA_TRIAL_REQUIRES_CARD=value
        assert.equal(cardRequiredTrial(),false)
      }
      process.env.MCA_TRIAL_REQUIRES_CARD="true"
      assert.equal(cardRequiredTrial(),true)
    })
    withStripeMode(true, () => {
      process.env.STRIPE_SECRET_KEY="sk_live_invalid_for_test_mode"
      assert.equal(isStripeCheckoutTrialConfigured(),false)
      assert.equal(cardRequiredTrial(),true)
    })
  } finally {if(previous===undefined)delete process.env.MCA_TRIAL_REQUIRES_CARD;else process.env.MCA_TRIAL_REQUIRES_CARD=previous}
})

restoreStripeEnv()
