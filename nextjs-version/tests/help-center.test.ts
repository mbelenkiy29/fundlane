import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { getHelpArticles, helpArticle, helpArticles } from "../src/lib/marketing/help"
import { getConfiguredSupportRows, getSupportConfig } from "../src/lib/marketing/support-config"

test("help articles have unique routes and actionable steps", () => {
  assert.equal(new Set(helpArticles.map(article => article.slug)).size, helpArticles.length)
  for (const article of helpArticles) {
    assert.equal(helpArticle(article.slug), article)
    assert.ok(article.steps.length >= 2)
    assert.match(article.slug, /^[a-z]+(?:-[a-z]+)*$/)
  }
  assert.equal(helpArticle("missing"), undefined)
})

test("expanded guides and approved seat wording require the exact flag", () => {
  const previous = process.env.MCA_HELP_CENTER_EXPANDED_ENABLED
  try {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.MCA_HELP_CENTER_EXPANDED_ENABLED
      else process.env.MCA_HELP_CENTER_EXPANDED_ENABLED = value
      assert.equal(getHelpArticles(), helpArticles)
      assert.equal(helpArticle("review-billing"), undefined)
    }
    process.env.MCA_HELP_CENTER_EXPANDED_ENABLED = "true"
    const articles = getHelpArticles()
    assert.equal(articles.length, helpArticles.length + 2)
    assert.deepEqual(articles.slice(0, 4), helpArticles)
    for (const slug of ["invite-teammates-and-manage-seats", "review-billing"]) {
      const article = helpArticle(slug)
      assert.ok(article)
      assert.match(article.steps.join(" "), /Settings → (Team|Plans & Billing)/)
      assert.match(article.steps.join(" "), /Removing a user frees their seat for someone else but doesn't lower your bill\./)
      assert.match(article.steps.join(" "), /Seat changes during the free trial are free\./)
    }
  } finally {
    if (previous === undefined) delete process.env.MCA_HELP_CENTER_EXPANDED_ENABLED
    else process.env.MCA_HELP_CENTER_EXPANDED_ENABLED = previous
  }
})

test("support resources remain unpublished until configured", () => {
  const previous = {
    enabled: process.env.MCA_PUBLIC_ROADMAP_ENABLED,
    statusEnabled: process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED,
    status: process.env.NEXT_PUBLIC_STATUS_PAGE_URL,
    roadmap: process.env.NEXT_PUBLIC_ROADMAP_URL,
    email: process.env.MCA_SUPPORT_EMAIL,
  }
  try {
    delete process.env.MCA_PUBLIC_ROADMAP_ENABLED
    delete process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED
    delete process.env.NEXT_PUBLIC_STATUS_PAGE_URL
    delete process.env.NEXT_PUBLIC_ROADMAP_URL
    delete process.env.MCA_SUPPORT_EMAIL
    assert.deepEqual(getSupportConfig(), { statusUrl: null, roadmapUrl: null, supportEmail: null })
    assert.deepEqual(getConfiguredSupportRows(getSupportConfig()), [])

    process.env.MCA_SUPPORT_EMAIL = "help@example.com"
    assert.deepEqual(getConfiguredSupportRows(getSupportConfig()), [
      { label: "Support", href: "mailto:help@example.com", linkText: "help@example.com" },
    ])

    process.env.NEXT_PUBLIC_STATUS_PAGE_URL = "http://example.com/status"
    process.env.NEXT_PUBLIC_ROADMAP_URL = "https://user:pass@example.com/roadmap"
    process.env.MCA_SUPPORT_EMAIL = "not an email"
    assert.deepEqual(getSupportConfig(), { statusUrl: null, roadmapUrl: null, supportEmail: null })
    assert.deepEqual(getConfiguredSupportRows(getSupportConfig()), [])

    process.env.NEXT_PUBLIC_STATUS_PAGE_URL = "https://status.example.com/"
    process.env.NEXT_PUBLIC_ROADMAP_URL = "https://roadmap.example.com/"
    process.env.MCA_SUPPORT_EMAIL = " help@example.com "
    assert.deepEqual(getSupportConfig(), {
      statusUrl: "https://status.example.com/",
      roadmapUrl: "https://roadmap.example.com/",
      supportEmail: "help@example.com",
    })
    assert.deepEqual(getConfiguredSupportRows(getSupportConfig()), [
      { label: "Support", href: "mailto:help@example.com", linkText: "help@example.com" },
      { label: "System status", href: "https://status.example.com/", linkText: "View status page" },
      { label: "Roadmap", href: "https://roadmap.example.com/", linkText: "View roadmap" },
    ])
    process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED = "true"
    assert.deepEqual(getConfiguredSupportRows(getSupportConfig())[1], { label: "System status", href: "/status", linkText: "System status" })
    process.env.MCA_PUBLIC_ROADMAP_ENABLED = "true"
    assert.deepEqual(getConfiguredSupportRows(getSupportConfig()).at(-1), { label: "Roadmap", href: "/roadmap", linkText: "Roadmap" })
  } finally {
    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_STATUS_PAGE_URL: previous.status,
      NEXT_PUBLIC_ROADMAP_URL: previous.roadmap,
      MCA_SUPPORT_EMAIL: previous.email,
      MCA_PUBLIC_ROADMAP_ENABLED: previous.enabled,
      MCA_PUBLIC_STATUS_PAGE_ENABLED: previous.statusEnabled,
    })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("assisted onboarding prompt needs both the help flag and valid support email", () => {
  const script = `
    const { mock } = require("node:test");
    const { renderToStaticMarkup } = require("react-dom/server");
    mock.module("server-only", { exports: {} });
    mock.module("./src/components/marketing/shell.tsx", { namedExports: { MarketingShell: ({ children }) => children } });
    const Page = require("./src/app/help/page.tsx").default;
    delete process.env.MCA_HELP_CENTER_EXPANDED_ENABLED;
    process.env.MCA_SUPPORT_EMAIL = "help@example.test";
    const off = renderToStaticMarkup(Page());
    process.env.MCA_HELP_CENTER_EXPANDED_ENABLED = "true";
    process.env.MCA_SUPPORT_EMAIL = "bad address";
    const invalid = renderToStaticMarkup(Page());
    process.env.MCA_SUPPORT_EMAIL = "help@example.test";
    const on = renderToStaticMarkup(Page());
    console.log(JSON.stringify({ off, invalid, on }));
  `
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const { off, invalid, on } = JSON.parse(result.stdout) as { off: string; invalid: string; on: string }
  assert.doesNotMatch(off, /Onboarding:|Invite teammates and manage seats/)
  assert.match(invalid, /Invite teammates and manage seats/)
  assert.doesNotMatch(invalid, /Onboarding:/)
  assert.match(on, /Onboarding: set up on your own with our guides, or <a[^>]+href="mailto:help@example\.test"[^>]*>email us<\/a> for help getting your company set up\./)
})
