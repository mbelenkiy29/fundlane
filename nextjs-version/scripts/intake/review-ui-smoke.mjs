// Run: MCA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/intake/review-ui-smoke.mjs
// Uses synthetic API responses; never connects to a database or sends email.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { build } from "esbuild"
import { mkdir, readFile } from "node:fs/promises"
import postcss from "postcss"
import tailwind from "@tailwindcss/postcss"

const { chromium } = await import(process.env.MCA_PLAYWRIGHT_MODULE || "playwright")
const bundle = await build({
  stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import {ApplicationReviewWorkspace} from "./src/components/mca/intake/application-review"; createRoot(document.getElementById("root")).render(<ApplicationReviewWorkspace intakeId="test"/>);', resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
})
const css = await postcss([tailwind()]).process(await readFile("src/app/globals.css", "utf8"), { from: "src/app/globals.css" })
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/app.js" ? "text/javascript" : req.url === "/app.css" ? "text/css" : "text/html")
  res.end(req.url === "/app.js" ? bundle.outputFiles[0].text : req.url === "/app.css" ? css.css : '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="--font-inter:Arial,sans-serif"><div id="root"></div><script src="/app.js"></script></body></html>')
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const browser = await chromium.launch({ headless: true, channel: process.env.MCA_BROWSER_CHANNEL || "chrome" })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(10000)
  page.on("pageerror", error => console.error(error))
  const review = {
    intakeId: "test", dealId: "deal", merchantName: "Synthetic Café", receivedAt: new Date().toISOString(), provider: "native", originalAnswersAvailable: true,
    answers: [{ key: "legalName", label: "Legal name", value: "Private original answer <script>alert(1)</script>" }],
    documents: [{ id: "doc", displayFilename: "statement.pdf", originalFilename: "statement.pdf", category: "statement", processingState: "clean" }],
    progress: { state: "ready_for_review", stages: Object.fromEntries(["deal", "documents", "underwriting", "matches"].map(key => [key, { state: "complete" }])) },
    summary: { reportedMonthlyRevenue: 25000, statementMonthlyRevenue: 24000, industry: "Hospitality", requestedAmount: 10000, warnings: [], missing: [], stale: false, analyzedAt: new Date().toISOString() },
    candidates: [{ id: "funder", name: "Synthetic Funder", rank: 1, score: 92, grade: "A", eligible: true, reasons: ["Meets requirements"] }], canPrepare: true, canRetry: true, jobs: [],
  }
  let denied = false, sends = 0, prepares = 0, expiryOffset = 60000
  let previewErrors = []
  await page.route("**/api/**", async route => {
    const url = route.request().url()
    let body = review
    if (url.endsWith("/preview")) {
      prepares++
      body = { id: "preview", expiresAt: new Date(Date.now() + expiryOffset).toISOString(), destinations: [{ funderId: "funder", name: "Synthetic Funder", method: "email", destination: "funder@example.test", documents: [{ id: "doc", filename: "statement.pdf" }], email: { from: "rep@example.test", to: ["funder@example.test"], cc: [], replyTo: "rep@example.test", subject: "Application", body: "Please review this application." }, errors: previewErrors }] }
    } else if (url.endsWith("/send")) { sends++; body = { ok: true, jobs: [{ jobId: "job", funderId: "funder", state: "pending_portal" }] } }
    else if (url.endsWith("/download-token")) body = { url: "/synthetic-document" }
    else if (denied) return route.fulfill({ status: 403, json: { error: { message: "Access denied" } } })
    return route.fulfill({ json: body })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole("heading", { name: "Synthetic Café" }).waitFor()
  await mkdir("output/application-review", { recursive: true })
  await page.screenshot({ path: "output/application-review/mobile.png", fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Mobile content must not overflow")
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: "output/application-review/desktop.png", fullPage: true })
  assert.equal(await page.getByRole("checkbox").isChecked(), false)
  assert.equal(await page.getByRole("button", { name: /Prepare/ }).isDisabled(), true)
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  assert.equal(await page.getByRole("checkbox").isChecked(), true)
  await page.getByRole("button", { name: /Prepare/ }).click()
  await page.getByRole("heading", { name: "Submission preview" }).waitFor()
  assert.equal(sends, 0, "Preparing must never send")
  assert.equal(prepares, 1)
  await page.screenshot({ path: "output/application-review/preview.png", fullPage: true })
  expiryOffset = -1000
  await page.getByRole("button", { name: /Prepare/ }).click()
  await page.getByText("This preview expired or the application changed.", { exact: false }).waitFor()
  assert.equal(await page.getByRole("button", { name: "Send approved submissions" }).isDisabled(), true)
  expiryOffset = 60000
  previewErrors = ["Sender must be configured."]
  await page.getByRole("button", { name: /Prepare/ }).click()
  await page.getByText("Sender must be configured.", { exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "Send approved submissions" }).isDisabled(), true)
  previewErrors = []
  await page.getByRole("checkbox").uncheck()
  assert.equal(await page.getByRole("heading", { name: "Submission preview" }).count(), 0)
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: /Prepare/ }).click()
  await page.getByRole("heading", { name: "Submission preview" }).waitFor()
  review.summary.stale = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await page.getByText("This preview expired or the application changed.", { exact: false }).waitFor()
  assert.equal(await page.getByRole("button", { name: "Send approved submissions" }).isDisabled(), true)
  review.summary.stale = false
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(button => button.textContent.includes("Prepare"))?.disabled)
  await page.getByRole("button", { name: /Prepare/ }).click()
  await page.getByRole("heading", { name: "Submission preview" }).waitFor()
  await page.getByRole("button", { name: "Send approved submissions" }).click()
  await page.getByRole("link", { name: "Complete portal submission in deal" }).waitFor()
  assert.equal(sends, 1)
  const popupPromise = page.waitForEvent("popup")
  await page.getByRole("button", { name: "Preview statement.pdf in a new tab" }).click()
  const popup = await popupPromise
  await popup.waitForURL("**/synthetic-document?preview=1")
  assert.ok(page.url().endsWith("/"), "Preview preserves the review page")
  await popup.close()
  denied = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await page.getByText("Access denied", { exact: true }).waitFor()
  assert.equal(await page.getByText("Private original answer", { exact: false }).count(), 0)
  assert.equal(await page.getByRole("checkbox").count(), 0)
  assert.equal(await page.getByRole("heading", { name: "Synthetic Café" }).count(), 0)
  console.log("Review UI smoke passed: default selection, prepare/send separation, selection persistence, preview invalidation, manual portal, document preview, and revoked access.")
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
