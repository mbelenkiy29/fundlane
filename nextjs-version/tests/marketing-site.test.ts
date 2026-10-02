import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
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
import { helpArticles } from "../src/lib/marketing/help"
import { companyLegalName, marketingPolishEnabled } from "../src/lib/marketing/polish"
import { publicRoadmapEnabled } from "../src/lib/marketing/launch-switches"

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

test("FAQ JSON-LD is valid and uses the page's own visible answers", () => {
  const faq = [["What can I review?", "Applications and submissions."], ["Can we import deals?", "Use spreadsheet imports."]] as const
  const parsed = JSON.parse(JSON.stringify(marketingJsonLd({ title: "Home", path: "/", faq })))
  const faqPage = parsed["@graph"].find((node: { "@type": string }) => node["@type"] === "FAQPage")
  assert.equal(faqPage.mainEntity.length, faq.length)
  assert.deepEqual(faqPage.mainEntity.map((item: { name: string; acceptedAnswer: { text: string } }) => [item.name, item.acceptedAnswer.text]), faq)
  assert.doesNotMatch(JSON.stringify(parsed), /"offers"|"price"/i)
})

test("marketing polish and legal name have safe empty defaults", () => {
  const flag = process.env.MCA_MARKETING_POLISH_ENABLED
  const name = process.env.NEXT_PUBLIC_MCA_COMPANY_LEGAL_NAME
  try {
    delete process.env.MCA_MARKETING_POLISH_ENABLED
    delete process.env.NEXT_PUBLIC_MCA_COMPANY_LEGAL_NAME
    assert.equal(marketingPolishEnabled(), false)
    assert.equal(companyLegalName(), null)
    process.env.MCA_MARKETING_POLISH_ENABLED = "TRUE"
    assert.equal(marketingPolishEnabled(), false)
    process.env.MCA_MARKETING_POLISH_ENABLED = "true"
    process.env.NEXT_PUBLIC_MCA_COMPANY_LEGAL_NAME = "  Example Legal LLC  "
    assert.equal(marketingPolishEnabled(), true)
    assert.equal(companyLegalName(), "Example Legal LLC")
  } finally {
    if (flag === undefined) delete process.env.MCA_MARKETING_POLISH_ENABLED
    else process.env.MCA_MARKETING_POLISH_ENABLED = flag
    if (name === undefined) delete process.env.NEXT_PUBLIC_MCA_COMPANY_LEGAL_NAME
    else process.env.NEXT_PUBLIC_MCA_COMPANY_LEGAL_NAME = name
  }
})

test("marketing font preloads preserve the default and turn off only with polish enabled", () => {
  const script = `
    const { mock } = require("node:test");
    const calls = [];
    mock.module("next/font/local", { exports: { default: options => {
      calls.push(options);
      return { variable: options.variable };
    } } });
    const { marketingFontClasses } = require("./src/lib/marketing/fonts.ts");
    (async () => {
      const currentClasses = await marketingFontClasses(false);
      const current = calls.splice(0);
      const polishedClasses = await marketingFontClasses(true);
      console.log(JSON.stringify({ currentClasses, current, polishedClasses, polished: calls }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], {
    encoding: "utf8",
    cwd: resolve(import.meta.dirname, ".."),
  })
  assert.equal(result.status, 0, result.stderr)
  const { currentClasses, current, polishedClasses, polished } = JSON.parse(result.stdout) as {
    currentClasses: string
    current: { src: string; preload: boolean; variable: string }[]
    polishedClasses: string
    polished: { src: string; preload: boolean; variable: string }[]
  }
  assert.equal(current.length, 3)
  assert.deepEqual(current.map(font => font.preload), [true, true, true])
  assert.equal(polished.length, 1)
  assert.equal(polished[0].preload, false)
  assert.match(polished[0].src, /GeistMono-Regular\.woff2$/)
  for (const font of current) assert.ok(currentClasses.includes(font.variable))
  assert.equal(polishedClasses, polished[0].variable)
})

test("internal demo link in mobile navigation has no external arrow when polished", () => {
  const script = `
    const React = require("react");
    const { renderToStaticMarkup } = require("react-dom/server");
    const { MobileNav } = require("./src/components/marketing/mobile-nav.tsx");
    console.log(JSON.stringify([false, true].map(polished => renderToStaticMarkup(React.createElement(MobileNav, { polished })))))
  `
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8", cwd: resolve(import.meta.dirname, "..") })
  assert.equal(result.status, 0, result.stderr)
  const [current, polished] = JSON.parse(result.stdout) as string[]
  assert.match(current, /Book a demo <span aria-hidden="true">↗<\/span>/)
  assert.match(polished, /Book a demo/)
  assert.doesNotMatch(polished, /↗/)
})

test("sitemap includes lastmod for each public marketing URL", () => {
  const entries = sitemap()
  assert.deepEqual(
    entries.map((entry) => entry.url),
    [MARKETING_ORIGIN, `${MARKETING_ORIGIN}/features`, `${MARKETING_ORIGIN}/changelog`, `${MARKETING_ORIGIN}/help`, ...helpArticles.map(article => `${MARKETING_ORIGIN}/help/${article.slug}`)],
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
  assert.ok(allow.includes("/help"))
  assert.ok(!allow.includes("/terms$"))
  assert.ok(!allow.includes("/privacy$"))
})

test("public roadmap discovery requires the exact flag", () => {
  const previous = process.env.MCA_PUBLIC_ROADMAP_ENABLED
  try {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.MCA_PUBLIC_ROADMAP_ENABLED
      else process.env.MCA_PUBLIC_ROADMAP_ENABLED = value
      assert.equal(publicRoadmapEnabled(), false)
      assert.ok(!sitemap().some(entry => entry.url.endsWith("/roadmap")))
      assert.ok(!(robots().rules as { allow: string[] }).allow.includes("/roadmap$"))
    }
    process.env.MCA_PUBLIC_ROADMAP_ENABLED = "true"
    assert.equal(publicRoadmapEnabled(), true)
    const entry = sitemap().find(row => row.url.endsWith("/roadmap"))
    assert.deepEqual(entry?.lastModified, new Date("2026-09-28"))
    assert.ok((robots().rules as { allow: string[] }).allow.includes("/roadmap$"))
  } finally {
    if (previous === undefined) delete process.env.MCA_PUBLIC_ROADMAP_ENABLED
    else process.env.MCA_PUBLIC_ROADMAP_ENABLED = previous
  }
})

test("public status discovery requires the exact flag", () => {
  const previous = process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED
  try {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED
      else process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED = value
      assert.ok(!sitemap().some(entry => entry.url.endsWith("/status")))
      assert.ok(!(robots().rules as { allow: string[] }).allow.includes("/status$"))
    }
    process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED = "true"
    assert.ok(sitemap().some(entry => entry.url.endsWith("/status")))
    assert.ok((robots().rules as { allow: string[] }).allow.includes("/status$"))
  } finally {
    if (previous === undefined) delete process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED
    else process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED = previous
  }
})

test("marketing shell and mobile navigation prefer internal roadmap only when enabled", () => {
  const script = `
    const React = require("react");
    const { mock } = require("node:test");
    const { renderToStaticMarkup } = require("react-dom/server");
    require.extensions[".css"] = () => {};
    mock.module("server-only", { exports: {} });
    mock.module("./src/lib/marketing/fonts.ts", { namedExports: { marketingFontClasses: async () => "" } });
    const { MarketingShell } = require("./src/components/marketing/shell.tsx");
    (async () => {
      process.env.NEXT_PUBLIC_ROADMAP_URL = "https://roadmap.example.test/";
      delete process.env.MCA_PUBLIC_ROADMAP_ENABLED;
      const off = renderToStaticMarkup(await MarketingShell({ children: null }));
      process.env.MCA_PUBLIC_ROADMAP_ENABLED = "true";
      const on = renderToStaticMarkup(await MarketingShell({ children: null }));
      console.log(JSON.stringify({ off, on }));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { encoding: "utf8", cwd: resolve(import.meta.dirname, "..") })
  assert.equal(result.status, 0, result.stderr)
  const { off, on } = JSON.parse(result.stdout) as { off: string; on: string }
  assert.match(off, /href="https:\/\/roadmap\.example\.test\/"/)
  assert.doesNotMatch(off, /href="\/roadmap"/)
  assert.match(on, /href="\/roadmap"/)
  assert.doesNotMatch(on, /href="https:\/\/roadmap\.example\.test\/"/)
  assert.match(on, /Mobile navigation[\s\S]*href="\/roadmap"/)
})

test("marketing footer preserves external status link until internal status is enabled", () => {
  const script = `
    const { mock } = require("node:test");
    const { renderToStaticMarkup } = require("react-dom/server");
    require.extensions[".css"] = () => {};
    mock.module("server-only", { exports: {} });
    mock.module("./src/lib/marketing/fonts.ts", { namedExports: { marketingFontClasses: async () => "" } });
    const { MarketingShell } = require("./src/components/marketing/shell.tsx");
    (async () => {
      process.env.NEXT_PUBLIC_STATUS_PAGE_URL = "https://status.example.test/";
      delete process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED;
      const off = renderToStaticMarkup(await MarketingShell({ children: null }));
      process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED = "true";
      const on = renderToStaticMarkup(await MarketingShell({ children: null }));
      console.log(JSON.stringify({ off, on }));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { encoding: "utf8", cwd: resolve(import.meta.dirname, "..") })
  assert.equal(result.status, 0, result.stderr)
  const { off, on } = JSON.parse(result.stdout) as { off: string; on: string }
  assert.match(off, /href="https:\/\/status\.example\.test\/"/)
  assert.doesNotMatch(off, /href="\/status"/)
  assert.match(on, /href="\/status"/)
  assert.doesNotMatch(on, /href="https:\/\/status\.example\.test\/"/)
})
