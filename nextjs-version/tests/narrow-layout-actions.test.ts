import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

function renderMarkup(source: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", source], {
    encoding: "utf8",
    cwd: process.cwd(),
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test("New deal stays available from the sm breakpoint with an accessible name", () => {
  const html = renderMarkup(`
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { NewDealHeaderAction } = require('./src/components/mca/deals/new-deal-header-action.tsx');
    console.log(renderToStaticMarkup(React.createElement(NewDealHeaderAction, { onOpen: () => {} })));
  `)
  assert.match(html, /aria-label="New deal"/)
  assert.match(html, /hidden sm:inline-flex/)
  assert.doesNotMatch(html, /hidden md:inline-flex/)
  assert.match(html, /<span class="hidden md:inline">New deal<\/span>/)
})

test("customer insight tabs keep Growth, Demographics, and Regions in the accessibility tree", () => {
  const html = renderMarkup(`
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { CustomerInsights } = require('./src/app/(dashboard)/dashboard-2/components/customer-insights.tsx');
    console.log(renderToStaticMarkup(React.createElement(CustomerInsights, {
      growth: [],
      industries: [],
      states: [],
    })));
  `)
  for (const name of ["Growth", "Demographics", "Regions"]) {
    assert.match(html, new RegExp(`sr-only md:not-sr-only">${name}<`))
  }
  assert.doesNotMatch(html, /hidden md:inline/)
})
