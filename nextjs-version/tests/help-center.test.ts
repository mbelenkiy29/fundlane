import test from "node:test"
import assert from "node:assert/strict"
import { helpArticle, helpArticles } from "../src/lib/marketing/help"
import { getSupportConfig } from "../src/lib/marketing/support-config"

test("help articles have unique routes and actionable steps", () => {
  assert.equal(new Set(helpArticles.map(article => article.slug)).size, helpArticles.length)
  for (const article of helpArticles) {
    assert.equal(helpArticle(article.slug), article)
    assert.ok(article.steps.length >= 2)
    assert.match(article.slug, /^[a-z]+(?:-[a-z]+)*$/)
  }
  assert.equal(helpArticle("missing"), undefined)
})

test("support resources remain unpublished until configured", () => {
  const previous = {
    status: process.env.NEXT_PUBLIC_STATUS_PAGE_URL,
    roadmap: process.env.NEXT_PUBLIC_ROADMAP_URL,
    email: process.env.MCA_SUPPORT_EMAIL,
  }
  try {
    delete process.env.NEXT_PUBLIC_STATUS_PAGE_URL
    delete process.env.NEXT_PUBLIC_ROADMAP_URL
    delete process.env.MCA_SUPPORT_EMAIL
    assert.deepEqual(getSupportConfig(), { statusUrl: null, roadmapUrl: null, supportEmail: null })

    process.env.NEXT_PUBLIC_STATUS_PAGE_URL = "http://example.com/status"
    process.env.NEXT_PUBLIC_ROADMAP_URL = "https://user:pass@example.com/roadmap"
    process.env.MCA_SUPPORT_EMAIL = "not an email"
    assert.deepEqual(getSupportConfig(), { statusUrl: null, roadmapUrl: null, supportEmail: null })

    process.env.NEXT_PUBLIC_STATUS_PAGE_URL = "https://status.example.com/"
    process.env.NEXT_PUBLIC_ROADMAP_URL = "https://roadmap.example.com/"
    process.env.MCA_SUPPORT_EMAIL = " help@example.com "
    assert.deepEqual(getSupportConfig(), {
      statusUrl: "https://status.example.com/",
      roadmapUrl: "https://roadmap.example.com/",
      supportEmail: "help@example.com",
    })
  } finally {
    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_STATUS_PAGE_URL: previous.status,
      NEXT_PUBLIC_ROADMAP_URL: previous.roadmap,
      MCA_SUPPORT_EMAIL: previous.email,
    })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
