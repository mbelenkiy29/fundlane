import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { BILLING_CATALOG, TRIAL_DAYS } from "../src/lib/mca/billing-catalog"
import { anonymousRequestDisposition } from "../src/lib/mca/app-paths"
import { publicPricingEnabled } from "../src/lib/marketing/launch-switches"
import { marketingTrialEnrollmentEnabled } from "../src/lib/marketing/trial-availability"
import { MARKETING_ORIGIN } from "../src/lib/marketing/metadata"
import sitemap from "../src/app/sitemap"
import robots from "../src/app/robots"
import { billingTaxCopy, stripeTaxBehavior } from "../src/lib/mca/billing-tax"

const readyEnrollment = {
  MCA_ONBOARDING_RUNTIME_ENABLED: "true",
  MCA_STRIPE_FIRST_ONBOARDING_ENABLED: "true",
  MCA_STRIPE_BILLING_ENABLED: "true",
  MCA_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_synthetic",
  STRIPE_BASE_PRICE_ID: "price_syntheticbase",
  STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_syntheticseats",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_synthetic",
}

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("public pricing and trial CTA default off and parse flags strictly", () => {
  withEnv({ MCA_PUBLIC_PRICING_ENABLED: undefined, MCA_MARKETING_TRIAL_CTA_ENABLED: undefined, MCA_SIGNUP_MODE: "open" }, () => {
    assert.equal(publicPricingEnabled(), false)
    assert.equal(marketingTrialEnrollmentEnabled(), false)
    assert.equal(anonymousRequestDisposition("/pricing"), "public")
    assert.equal(sitemap().some(entry => entry.url === `${MARKETING_ORIGIN}/pricing`), false)
    assert.equal((robots().rules as { allow: string[] }).allow.includes("/pricing$"), false)
  })
  withEnv({ MCA_PUBLIC_PRICING_ENABLED: "TRUE", MCA_MARKETING_TRIAL_CTA_ENABLED: "TRUE", MCA_SIGNUP_MODE: "open" }, () => {
    assert.equal(publicPricingEnabled(), false)
    assert.equal(marketingTrialEnrollmentEnabled(), false)
  })
  withEnv({ ...readyEnrollment, MCA_PUBLIC_PRICING_ENABLED: "true", MCA_MARKETING_TRIAL_CTA_ENABLED: "true", MCA_SIGNUP_MODE: "open" }, () => {
    assert.equal(publicPricingEnabled(), true)
    assert.equal(marketingTrialEnrollmentEnabled(), true)
    assert.equal(anonymousRequestDisposition("/pricing"), "public")
    assert.equal(sitemap().some(entry => entry.url === `${MARKETING_ORIGIN}/pricing`), true)
    assert.equal((robots().rules as { allow: string[] }).allow.includes("/pricing$"), true)
  })
  withEnv({ MCA_MARKETING_TRIAL_CTA_ENABLED: "true", MCA_SIGNUP_MODE: "invite_only" }, () => {
    assert.equal(marketingTrialEnrollmentEnabled(), false)
  })
})

function renderLaunch(env: Record<string, string | undefined>) {
  const script = `
    const React = require("react");
    const { mock } = require("node:test");
    const { renderToStaticMarkup } = require("react-dom/server");
    require.extensions[".css"] = () => {};
    mock.module("server-only", { exports: {} });
    mock.module("next/navigation", { namedExports: { redirect: location => { throw new Error("REDIRECT:" + location) } } });
    mock.module("./src/lib/marketing/fonts.ts", { namedExports: { marketingFontClasses: async () => "" } });
    const { MarketingShell } = require("./src/components/marketing/shell.tsx");
    const { MobileNav } = require("./src/components/marketing/mobile-nav.tsx");
    const { SiteFooter } = require("./src/components/site-footer.tsx");
    const { marketingTrialEnrollmentEnabled } = require("./src/lib/marketing/trial-availability.ts");
    const PricingPage = require("./src/app/(dashboard)/pricing/page.tsx").default;
    (async () => {
      const shell = await MarketingShell({ children: null });
      let pricing;
      try { const page = PricingPage(); pricing = renderToStaticMarkup(await page.type(page.props)); } catch (error) { pricing = String(error.message); }
      console.log(JSON.stringify({ shell: renderToStaticMarkup(shell), mobile: renderToStaticMarkup(React.createElement(MobileNav, { showPricing: process.env.MCA_PUBLIC_PRICING_ENABLED === "true", showTrialCta: marketingTrialEnrollmentEnabled() })), pricing, footer: renderToStaticMarkup(React.createElement(SiteFooter, { supportEmail: process.env.MCA_SUPPORT_EMAIL || null })) }));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `
  const childEnv = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key]
    else childEnv[key] = value
  }
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env: childEnv })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as { shell: string; mobile: string; pricing: string; footer: string }
}

test("disabled launch flags keep unavailable pricing readable and marketing links absent", () => {
  const result = renderLaunch({ MCA_PUBLIC_PRICING_ENABLED: undefined, MCA_MARKETING_TRIAL_CTA_ENABLED: undefined, MCA_SUPPORT_EMAIL: undefined })
  assert.match(result.pricing, /trial enrollment is currently unavailable/i)
  assert.doesNotMatch(result.shell, /href="\/pricing"|Get Started/)
  assert.doesNotMatch(result.mobile, /href="\/pricing"|Get Started/)
  assert.match(result.shell, /href="\/sign-in"[^>]*>Login/)
  assert.doesNotMatch(result.footer, /mailto:/)
})

test("enabled pricing uses catalog values and configured support, with gated CTA", () => {
  const result = renderLaunch({ ...readyEnrollment, MCA_PUBLIC_PRICING_ENABLED: "true", MCA_MARKETING_TRIAL_CTA_ENABLED: "true", MCA_SIGNUP_MODE: "open", MCA_SUPPORT_EMAIL: "help@example.com", MCA_STRIPE_TAX_BEHAVIOR: undefined })
  for (const amount of [BILLING_CATALOG.base.unitAmountCents, ...BILLING_CATALOG.additionalSeats.tiers.map(tier => tier.unitAmountCents)]) {
    assert.match(result.pricing, new RegExp(`\\$${amount / 100}`))
  }
  assert.match(result.pricing, new RegExp(`${TRIAL_DAYS}-day free trial`))
  assert.match(result.pricing, /A card is required to start/)
  assert.match(result.pricing, /automatically converts to \$399 per month unless you cancel before the trial ends/)
  assert.match(result.pricing, /Sales tax is added where applicable/)
  assert.match(result.pricing, /You choose how many seats to buy/)
  assert.match(result.pricing, /Removing a user frees their seat/)
  assert.match(result.pricing, /AI credits: coming soon\./)
  assert.match(result.pricing, /Onboarding: set up on your own with our guides/)
  assert.match(result.pricing, /href="mailto:help@example.com">email us<\/a>/)
  assert.match(result.pricing, /Users 2–10|Users 2<!-- -->–10/)
  assert.match(result.pricing, /help@example.com/)
  assert.match(result.shell, /href="\/pricing"[^>]*>Pricing/)
  assert.match(result.shell, /href="\/pricing"[^>]*>Get Started/)
  assert.match(result.mobile, /href="\/pricing"[^>]*>Pricing/)
  assert.match(result.mobile, /href="\/pricing"[^>]*>Get Started/)
  assert.match(result.footer, /mailto:help@example.com/)
  const invite = renderLaunch({ ...readyEnrollment, MCA_PUBLIC_PRICING_ENABLED: "true", MCA_MARKETING_TRIAL_CTA_ENABLED: "true", MCA_SIGNUP_MODE: "invite_only" })
  assert.match(invite.pricing, /trial enrollment is currently unavailable/i)
  assert.doesNotMatch(invite.pricing, /href="\/sign-up"/)
  assert.doesNotMatch(invite.shell, /Get Started/)
  assert.doesNotMatch(invite.mobile, /Get Started/)
})

test("marketing purchase navigation requires complete enrollment rollout and Stripe configuration", () => {
  const ready = { ...readyEnrollment, MCA_PUBLIC_PRICING_ENABLED: "true", MCA_MARKETING_TRIAL_CTA_ENABLED: "true", MCA_SIGNUP_MODE: "open" }
  for (const disabled of [
    { MCA_PUBLIC_PRICING_ENABLED: "false" },
    { MCA_ONBOARDING_RUNTIME_ENABLED: "false" },
    { MCA_STRIPE_FIRST_ONBOARDING_ENABLED: "false" },
    { MCA_STRIPE_MODE: "invalid" },
    { STRIPE_SECRET_KEY: "" },
    { STRIPE_BASE_PRICE_ID: "" },
    { STRIPE_BILLING_WEBHOOK_SECRET: "" },
  ]) {
    withEnv({ ...ready, ...disabled }, () => assert.equal(marketingTrialEnrollmentEnabled(), false))
  }
  const missing = renderLaunch({ ...ready, STRIPE_BASE_PRICE_ID: "" })
  assert.doesNotMatch(missing.shell, /Get Started/)
  assert.doesNotMatch(missing.mobile, /Get Started/)
  assert.match(missing.pricing, /trial enrollment is currently unavailable/i)
  assert.doesNotMatch(missing.pricing, /STRIPE_BASE_PRICE_ID|sk_test_synthetic|href="\/sign-up"/)
})

test("billing tax copy defaults to the exact current exclusive sentence", () => {
  assert.equal(billingTaxCopy({}), "Sales tax is added where applicable.")
  assert.equal(billingTaxCopy({ MCA_STRIPE_TAX_BEHAVIOR: "  " }), "Sales tax is added where applicable.")
  assert.equal(stripeTaxBehavior({}), undefined)
})

test("billing tax copy supports exclusive and inclusive behavior", () => {
  assert.equal(billingTaxCopy({ MCA_STRIPE_TAX_BEHAVIOR: "exclusive" }), "Sales tax is added where applicable.")
  assert.equal(billingTaxCopy({ MCA_STRIPE_TAX_BEHAVIOR: "inclusive" }), "Prices include applicable sales tax.")
  const exclusive = renderLaunch({ MCA_PUBLIC_PRICING_ENABLED: "true", MCA_STRIPE_TAX_BEHAVIOR: "exclusive" })
  const inclusive = renderLaunch({ MCA_PUBLIC_PRICING_ENABLED: "true", MCA_STRIPE_TAX_BEHAVIOR: "inclusive" })
  assert.match(exclusive.pricing, /Sales tax is added where applicable/)
  assert.match(inclusive.pricing, /Prices include applicable sales tax/)
})

test("billing tax copy rejects invalid configured behavior", () => {
  assert.throws(() => stripeTaxBehavior({ MCA_STRIPE_TAX_BEHAVIOR: "invalid" }), { status: 503, code: "billing_tax_behavior_invalid" })
  assert.equal(billingTaxCopy({ MCA_STRIPE_TAX_BEHAVIOR: "invalid" }), null)
  const result = renderLaunch({ MCA_PUBLIC_PRICING_ENABLED: "true", MCA_STRIPE_TAX_BEHAVIOR: "invalid" })
  assert.match(result.pricing, /Prices are in USD, billed monthly/)
  assert.doesNotMatch(result.pricing, /Sales tax is added|Prices include applicable sales tax/)
})

test("pricing hides onboarding email link when support address is absent", () => {
  const result = renderLaunch({ MCA_PUBLIC_PRICING_ENABLED: "true", MCA_SUPPORT_EMAIL: undefined })
  assert.match(result.pricing, /Onboarding: set up on your own with our guides\./)
  assert.doesNotMatch(result.pricing, /email us/)
})
