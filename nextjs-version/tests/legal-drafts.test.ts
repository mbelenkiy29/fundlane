import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { SignupLegalAgreement } from "../src/app/(auth)/sign-up/components/signup-legal-agreement"
import { getDemoConfiguration } from "../src/lib/marketing/config"
import { legalDraftPagesEnabled } from "../src/lib/marketing/legal-draft-flag"
import { legalPlaceholders, privacySections, termsSections } from "../src/lib/marketing/legal-drafts"
import { unauthenticatedPageGate } from "../src/lib/mca/app-paths"
import robots from "../src/app/robots"
import sitemap from "../src/app/sitemap"
import { MARKETING_ORIGIN } from "../src/lib/marketing/metadata"

function withEnvironment(values: Record<string, string | undefined>, run: () => void) {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    run()
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const demoValues = {
  MCA_DEMO_WEBHOOK_URL: "https://sales.example.test/demo",
  MCA_DEMO_WEBHOOK_TOKEN: "synthetic",
  MCA_MARKETING_PRIVACY_URL: "https://fundlane.io/privacy",
}

function renderRoutes(env: Record<string, string | undefined>) {
  const script = `
    const { mock } = require("node:test");
    const { renderToStaticMarkup } = require("react-dom/server");
    require.extensions[".css"] = () => {};
    mock.module("server-only", { exports: {} });
    mock.module("next/navigation", { exports: {
      redirect: location => { throw new Error("REDIRECT:" + location) },
      notFound: () => { throw new Error("NOT_FOUND") },
    } });
    mock.module("./src/lib/marketing/fonts.ts", { namedExports: { marketingFontClasses: async () => "" } });
    const terms = require("./src/app/terms/page.tsx");
    const privacy = require("./src/app/privacy/page.tsx");
    async function render(page) {
      try {
        const element = page();
        return renderToStaticMarkup(await element.type(element.props));
      } catch (error) { return String(error.message); }
    }
    (async () => console.log(JSON.stringify({
      terms: await render(terms.default),
      privacy: await render(privacy.default),
      termsMetadata: terms.generateMetadata(),
      privacyMetadata: privacy.generateMetadata(),
    })))().catch(error => { console.error(error); process.exitCode = 1 });
  `
  const childEnv = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key]
    else childEnv[key] = value
  }
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env: childEnv })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as { terms: string; privacy: string; termsMetadata: { description?: string }; privacyMetadata: { description?: string } }
}

test("page branches preserve the gated approved notice and flag draft rendering", () => {
  const root = resolve(import.meta.dirname, "../src/app")
  const privacyPage = readFileSync(resolve(root, "privacy/page.tsx"), "utf8")
  const termsPage = readFileSync(resolve(root, "terms/page.tsx"), "utf8")
  assert.match(privacyPage, /if \(!legalDraftPagesEnabled\(\)\)/)
  assert.match(privacyPage, /getDemoConfiguration\(\)\.privacyUrl !== "https:\/\/fundlane\.io\/privacy"/)
  assert.match(privacyPage, /privacyNotice\.map/)
  assert.match(privacyPage, /<LegalDraft title="Privacy Policy"/)
  assert.match(termsPage, /if \(!legalDraftPagesEnabled\(\)\) redirect\("\/sign-in\?returnTo=%2Fterms"\)/)
  assert.match(termsPage, /<LegalDraft title="Terms of Service"/)
})

test("unset and non-true flag preserve original legal and demo behavior", () => {
  for (const value of [undefined, "", "false", "TRUE", "1"]) {
    withEnvironment({ ...demoValues, MCA_LEGAL_DRAFT_PAGES_ENABLED: value }, () => {
      assert.equal(legalDraftPagesEnabled(), false)
      assert.deepEqual(unauthenticatedPageGate("/terms"), { action: "not-found", status: 404 })
      assert.equal(getDemoConfiguration().enabled, true)
      const urls = sitemap().map(entry => entry.url)
      assert.ok(!urls.includes(`${MARKETING_ORIGIN}/terms`))
      assert.ok(!urls.includes(`${MARKETING_ORIGIN}/privacy`))
      const allow = robots().rules
      assert.ok(allow && !Array.isArray(allow) && Array.isArray(allow.allow))
      if (allow && !Array.isArray(allow) && Array.isArray(allow.allow)) {
        assert.ok(!allow.allow.includes("/terms$"))
        assert.ok(!allow.allow.includes("/privacy$"))
      }
      const agreement = JSON.stringify(SignupLegalAgreement({ legalDraftsEnabled: false }))
      assert.match(agreement, /I agree to the terms of service and privacy policy\./)
      assert.doesNotMatch(agreement, /"href":"\/(terms|privacy)"/)
    })
  }
})

test("rendered disabled routes preserve redirect and approved notice", () => {
  for (const value of [undefined, "", "false", "TRUE", "1"]) {
    const approved = renderRoutes({ ...demoValues, MCA_LEGAL_DRAFT_PAGES_ENABLED: value })
    assert.equal(approved.terms, "REDIRECT:/sign-in?returnTo=%2Fterms")
    assert.deepEqual(approved.termsMetadata, {})
    assert.match(approved.privacy, /Website and demo privacy notice/)
    assert.match(approved.privacy, /ben@sentineltechsolutions\.io/)
    assert.doesNotMatch(approved.privacy, /prepared without attorney review/)
    assert.equal(approved.privacyMetadata.description, "How Sentinel Tech Solutions LLC handles Fundlane website and demo request information.")
  }
  const unavailable = renderRoutes({ MCA_LEGAL_DRAFT_PAGES_ENABLED: undefined, MCA_MARKETING_PRIVACY_URL: undefined })
  assert.equal(unavailable.privacy, "NOT_FOUND")
})

test("rendered enabled routes include every section and the publication notice", () => {
  const result = renderRoutes({ ...demoValues, MCA_LEGAL_DRAFT_PAGES_ENABLED: "true" })
  for (const [html, sections] of [[result.terms, termsSections], [result.privacy, privacySections]] as const) {
    assert.match(html, /These terms were prepared without attorney review and will be updated after legal review\./)
    assert.doesNotMatch(html, /DRAFT|\(draft\)|\[ZIP\]|\[Effective date\]|\[Attorney review|\[Proposed for review|[Nn]ot yet in effect|not reviewed by an attorney/)
    assert.match(html, /Sentinel Tech Solutions LLC/)
    assert.match(html, /7 Holly Hill Road, Marlboro, NJ/)
    assert.match(html, /mike@sentineltechsolutions\.io/)
    assert.match(html, /Effective date: September 28, 2026/)
    for (const section of sections) assert.equal(html.split(`<h2>${section.heading}</h2>`).length - 1, 1, section.heading)
  }
  for (const phrase of ["New Jersey", "Monmouth County", "pre-purchased seat model", "prorated and invoiced immediately", "take effect at renewal", "no-card trial", "card-backed Stripe trial", "TCPA", "automatic seat assignment", "fees the customer paid for the Service in the 12 months before the event giving rise to the claim"]) assert.ok(result.terms.includes(phrase), phrase)
  for (const phrase of ["OpenAI", "Gmail", "Microsoft", "Twilio", "Cloudmersive", "Verisys", "sidebar_state", "Local storage", "Information is retained according to its purpose", "not all Fundlane subprocessors"]) assert.ok(result.privacy.includes(phrase), phrase)
  assert.equal(result.termsMetadata.description, "Fundlane Terms of Service from Sentinel Tech Solutions LLC, effective September 28, 2026.")
  assert.equal(result.privacyMetadata.description, "How Sentinel Tech Solutions LLC handles information in Fundlane, effective September 28, 2026.")
})

test("enabled drafts cannot authorize demo collection at /privacy", () => {
  withEnvironment({ ...demoValues, MCA_LEGAL_DRAFT_PAGES_ENABLED: "true" }, () => {
    assert.equal(legalDraftPagesEnabled(), true)
    assert.equal(legalPlaceholders.company, "Sentinel Tech Solutions LLC")
    assert.equal(legalPlaceholders.address, "7 Holly Hill Road, Marlboro, NJ")
    assert.equal(legalPlaceholders.contact, "mike@sentineltechsolutions.io")
    assert.equal(legalPlaceholders.effectiveDate, "September 28, 2026")
    for (const [path, sections] of [["/terms", termsSections], ["/privacy", privacySections]] as const) {
      assert.deepEqual(unauthenticatedPageGate(path), { action: "allow", status: 200 })
      assert.ok(sections.length > 0)
    }
    assert.equal(getDemoConfiguration().enabled, false)
    assert.equal(getDemoConfiguration().privacyUrl, null)
    const urls = sitemap().map(entry => entry.url)
    assert.ok(urls.includes(`${MARKETING_ORIGIN}/terms`))
    assert.ok(urls.includes(`${MARKETING_ORIGIN}/privacy`))
    const rules = robots().rules
    assert.ok(rules && !Array.isArray(rules) && Array.isArray(rules.allow))
    if (rules && !Array.isArray(rules) && Array.isArray(rules.allow)) {
      assert.ok(rules.allow.includes("/terms$"))
      assert.ok(rules.allow.includes("/privacy$"))
    }
    const agreement = JSON.stringify(SignupLegalAgreement({ legalDraftsEnabled: true }))
    assert.match(agreement, /Terms of Service/)
    assert.doesNotMatch(agreement, /\(draft\)/)
    assert.match(agreement, /Privacy Policy/)
    assert.match(agreement, /"href":"\/terms"/)
    assert.match(agreement, /"href":"\/privacy"/)
  })
  for (const url of ["https://preview.example.test/privacy/", "https://fundlane.io/privacy?from=demo", "https://fundlane.io/%70rivacy"]) {
    for (const databaseEnabled of ["false", "true"]) {
      withEnvironment({ ...demoValues, MCA_LEGAL_DRAFT_PAGES_ENABLED: "true", MCA_DEMO_DB_SUBMISSIONS_ENABLED: databaseEnabled, MCA_MARKETING_PRIVACY_URL: url }, () => {
        assert.equal(getDemoConfiguration().enabled, false)
        assert.equal(getDemoConfiguration().privacyUrl, null)
      })
    }
  }
  withEnvironment({ ...demoValues, MCA_LEGAL_DRAFT_PAGES_ENABLED: "true", MCA_MARKETING_PRIVACY_URL: "https://fundlane.io/approved-notice" }, () => {
    assert.equal(getDemoConfiguration().enabled, true)
  })
})
