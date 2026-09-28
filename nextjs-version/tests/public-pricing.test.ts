import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { BILLING_CATALOG, TRIAL_DAYS } from "../src/lib/mca/billing-catalog"
import { anonymousRequestDisposition } from "../src/lib/mca/app-paths"
import { marketingTrialCtaEnabled, publicPricingEnabled } from "../src/lib/marketing/launch-switches"
import { MARKETING_ORIGIN } from "../src/lib/marketing/metadata"
import sitemap from "../src/app/sitemap"
import robots from "../src/app/robots"

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
    assert.equal(marketingTrialCtaEnabled(), false)
    assert.equal(anonymousRequestDisposition("/pricing"), "sign-in")
    assert.equal(sitemap().some(entry => entry.url === `${MARKETING_ORIGIN}/pricing`), false)
    assert.equal((robots().rules as { allow: string[] }).allow.includes("/pricing$"), false)
  })
  withEnv({ MCA_PUBLIC_PRICING_ENABLED: "TRUE", MCA_MARKETING_TRIAL_CTA_ENABLED: "TRUE", MCA_SIGNUP_MODE: "open" }, () => {
    assert.equal(publicPricingEnabled(), false)
    assert.equal(marketingTrialCtaEnabled(), false)
  })
  withEnv({ MCA_PUBLIC_PRICING_ENABLED: "true", MCA_MARKETING_TRIAL_CTA_ENABLED: "true", MCA_SIGNUP_MODE: "open" }, () => {
    assert.equal(publicPricingEnabled(), true)
    assert.equal(marketingTrialCtaEnabled(), true)
    assert.equal(anonymousRequestDisposition("/pricing"), "public")
    assert.equal(sitemap().some(entry => entry.url === `${MARKETING_ORIGIN}/pricing`), true)
    assert.equal((robots().rules as { allow: string[] }).allow.includes("/pricing$"), true)
  })
  withEnv({ MCA_MARKETING_TRIAL_CTA_ENABLED: "true", MCA_SIGNUP_MODE: "invite_only" }, () => {
    assert.equal(marketingTrialCtaEnabled(), false)
  })
})

function renderLaunch(env: Record<string, string | undefined>) {
  const script = `
    const React = require("react");
    const { mock } = require("node:test");
    const { renderToStaticMarkup } = require("react-dom/server");
    require.extensions[".css"] = () => {};
    mock.module("server-only", { exports: {} });
    mock.module("next/navigation", { exports: { redirect: location => { throw new Error("REDIRECT:" + location) } } });
    mock.module("./src/lib/marketing/fonts.ts", { namedExports: { marketingFontClasses: async () => "" } });
    const { MarketingShell } = require("./src/components/marketing/shell.tsx");
    const { MobileNav } = require("./src/components/marketing/mobile-nav.tsx");
    const { SiteFooter } = require("./src/components/site-footer.tsx");
    const PricingPage = require("./src/app/(dashboard)/pricing/page.tsx").default;
    (async () => {
      const shell = await MarketingShell({ children: null });
      let pricing;
      try { const page = PricingPage(); pricing = renderToStaticMarkup(await page.type(page.props)); } catch (error) { pricing = String(error.message); }
      console.log(JSON.stringify({ shell: renderToStaticMarkup(shell), mobile: renderToStaticMarkup(React.createElement(MobileNav, { showPricing: process.env.MCA_PUBLIC_PRICING_ENABLED === "true", showTrialCta: process.env.MCA_MARKETING_TRIAL_CTA_ENABLED === "true" && process.env.MCA_SIGNUP_MODE === "open" })), pricing, footer: renderToStaticMarkup(React.createElement(SiteFooter, { supportEmail: process.env.MCA_SUPPORT_EMAIL || null })) }));
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

test("disabled launch flags keep pricing private and marketing links absent", () => {
  const result = renderLaunch({ MCA_PUBLIC_PRICING_ENABLED: undefined, MCA_MARKETING_TRIAL_CTA_ENABLED: undefined, MCA_SUPPORT_EMAIL: undefined })
  assert.equal(result.pricing, "REDIRECT:/settings/billing")
  assert.doesNotMatch(result.shell, /href="\/pricing"|Start free trial/)
  assert.doesNotMatch(result.mobile, /href="\/pricing"|Start free trial/)
  assert.doesNotMatch(result.footer, /mailto:/)
})

test("enabled pricing uses catalog values and configured support, with gated CTA", () => {
  const result = renderLaunch({ MCA_PUBLIC_PRICING_ENABLED: "true", MCA_MARKETING_TRIAL_CTA_ENABLED: "true", MCA_SIGNUP_MODE: "open", MCA_SUPPORT_EMAIL: "help@example.com" })
  for (const amount of [BILLING_CATALOG.base.unitAmountCents, ...BILLING_CATALOG.additionalSeats.tiers.map(tier => tier.unitAmountCents)]) {
    assert.match(result.pricing, new RegExp(`\\$${amount / 100}`))
  }
  assert.match(result.pricing, new RegExp(`${TRIAL_DAYS}-day free trial`))
  assert.match(result.pricing, /A card is required to start\. Cancel anytime\./)
  assert.match(result.pricing, /Sales tax is added where applicable/)
  assert.match(result.pricing, /Adding users: prorated and invoiced immediately; access after payment\. Removing users: takes effect at the next renewal, with no mid-cycle credit\. No charge for seat changes during the free trial\./)
  assert.match(result.pricing, /Users 2–10|Users 2<!-- -->–10/)
  assert.match(result.pricing, /help@example.com/)
  assert.match(result.shell, /href="\/pricing"[^>]*>Pricing/)
  assert.match(result.shell, /href="\/sign-up"[^>]*>Start free trial/)
  assert.match(result.mobile, /href="\/pricing"[^>]*>Pricing/)
  assert.match(result.mobile, /href="\/sign-up"[^>]*>Start free trial/)
  assert.match(result.footer, /mailto:help@example.com/)
  const invite = renderLaunch({ MCA_PUBLIC_PRICING_ENABLED: "true", MCA_MARKETING_TRIAL_CTA_ENABLED: "true", MCA_SIGNUP_MODE: "invite_only" })
  assert.doesNotMatch(invite.pricing, /href="\/sign-up"[^>]*>Start free trial/)
  assert.doesNotMatch(invite.shell, /href="\/sign-up"[^>]*>Start free trial/)
  assert.doesNotMatch(invite.mobile, /href="\/sign-up"[^>]*>Start free trial/)
})
