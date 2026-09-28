import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { SignupLegalAgreement } from "../src/app/(auth)/sign-up/components/signup-legal-agreement"
import { LegalDraft } from "../src/components/marketing/legal-draft"
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
  for (const value of [undefined, "false", "TRUE", "1"]) {
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

test("enabled drafts are visible but cannot authorize demo collection at /privacy", () => {
  withEnvironment({ ...demoValues, MCA_LEGAL_DRAFT_PAGES_ENABLED: "true" }, () => {
    assert.equal(legalDraftPagesEnabled(), true)
    assert.equal(legalPlaceholders.company, "Sentinel Tech Solutions LLC")
    assert.equal(legalPlaceholders.address, "7 Holly Hill Road, Marlboro, NJ")
    assert.equal(legalPlaceholders.contact, "mike@sentineltechsolutions.io")
    assert.equal(legalPlaceholders.updated, "[date pending legal review]")
    for (const [path, sections] of [["/terms", termsSections], ["/privacy", privacySections]] as const) {
      assert.deepEqual(unauthenticatedPageGate(path), { action: "allow", status: 200 })
      const main = LegalDraft({ title: path === "/terms" ? "Terms of Service" : "Privacy Policy", sections })
      const copy = JSON.stringify(main)
      assert.match(copy, /DRAFT — pending legal review\. Not yet in effect\./)
      assert.match(copy, /\[date pending legal review\]/)
      assert.match(copy, /Sentinel Tech Solutions LLC/)
      assert.match(copy, /7 Holly Hill Road, Marlboro, NJ/)
      assert.match(copy, /mike@sentineltechsolutions\.io/)
      assert.doesNotMatch(copy, /\[(?:Company legal name|Company mailing address|contact email)\]/)
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
    assert.match(agreement, /Terms of Service \(draft\)/)
    assert.match(agreement, /Privacy Policy \(draft\)/)
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
