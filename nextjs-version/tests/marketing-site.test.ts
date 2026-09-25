import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import robots from "../src/app/robots"
import sitemap from "../src/app/sitemap"
import {
  DEMO_DESCRIPTION,
  MARKETING_DESCRIPTION,
  MARKETING_ORIGIN,
  MARKETING_SITEMAP_LASTMOD,
  marketingJsonLd,
  marketingMetadata,
} from "../src/lib/marketing/metadata"

test("marketing metadata uses Fundlane chrome and page-specific demo copy", () => {
  const home = marketingMetadata("MCA brokerage software, from application to renewal", "/")
  assert.deepEqual(home.title, { absolute: "MCA brokerage software, from application to renewal | Fundlane" })
  assert.equal(home.applicationName, "Fundlane")
  assert.equal(home.description, MARKETING_DESCRIPTION)
  assert.ok(home.appleWebApp && typeof home.appleWebApp === "object")
  assert.equal(home.appleWebApp.title, "Fundlane")

  const demo = marketingMetadata("Request a demo", "/demo", DEMO_DESCRIPTION)
  assert.deepEqual(demo.title, { absolute: "Request a demo | Fundlane" })
  assert.equal(demo.description, DEMO_DESCRIPTION)
  assert.equal(demo.openGraph?.description, DEMO_DESCRIPTION)
  assert.equal(demo.twitter?.description, DEMO_DESCRIPTION)
  assert.notEqual(demo.description, home.description)
})

test("JSON-LD describes Fundlane without pricing or legal-entity claims", () => {
  const data = marketingJsonLd({ title: "Request a demo", path: "/demo", description: DEMO_DESCRIPTION })
  const encoded = JSON.stringify(data)
  assert.equal(data["@context"], "https://schema.org")
  const types = data["@graph"].map((node) => node["@type"])
  assert.deepEqual(types, ["Organization", "WebSite", "SoftwareApplication", "WebPage"])
  const organization = data["@graph"].find((node) => node["@type"] === "Organization")
  const page = data["@graph"].find((node) => node["@type"] === "WebPage")
  assert.equal(organization?.name, "Fundlane")
  assert.equal(organization?.url, MARKETING_ORIGIN)
  assert.equal(page?.url, `${MARKETING_ORIGIN}/demo`)
  assert.equal(page?.description, DEMO_DESCRIPTION)
  assert.match(encoded, /Fundlane/)
  assert.doesNotMatch(encoded, /MCA Workspace/)
  assert.doesNotMatch(encoded, /"@type":"Offer"/)
  assert.doesNotMatch(encoded, /Sentinel Tech Solutions/)
})

test("mobile nav demo arrow stays visible below 760px", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../src/components/marketing/marketing.css"), "utf8")
  assert.doesNotMatch(css, /\.fl-nav-actions \.fl-button svg\s*\{\s*display:\s*none/)
})

test("sitemap includes lastmod for each public marketing URL", () => {
  const entries = sitemap()
  assert.deepEqual(
    entries.map((entry) => entry.url),
    [MARKETING_ORIGIN, `${MARKETING_ORIGIN}/features`, `${MARKETING_ORIGIN}/changelog`, `${MARKETING_ORIGIN}/demo`],
  )
  for (const entry of entries) {
    assert.deepEqual(entry.lastModified, MARKETING_SITEMAP_LASTMOD)
    assert.ok(entry.lastModified instanceof Date)
  }
})

test("robots allows each public marketing URL listed in the sitemap", () => {
  const rules = robots().rules
  assert.ok(rules && !Array.isArray(rules))
  const allow = rules.allow
  assert.ok(Array.isArray(allow))
  assert.ok(allow.includes("/$"))
  assert.ok(allow.includes("/features$"))
  assert.ok(allow.includes("/changelog$"))
  assert.ok(allow.includes("/demo$"))
})
