import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

// Render real shared UI outside the react-server condition used by the DB suites.
test("platform shell scopes navigation, highlights company details and gates Roadmap", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react'); const {renderToStaticMarkup} = require('react-dom/server');
    require.extensions['.css'] = () => {};
    const {AppRouterContext} = require('next/dist/shared/lib/app-router-context.shared-runtime');
    const {PathnameContext} = require('next/dist/shared/lib/hooks-client-context.shared-runtime');
    const {ThemeProvider} = require('./src/components/theme-provider.tsx');
    const {PlatformChrome} = require('./src/components/mca/platform/platform-chrome.tsx');
    const {CurrencyTotals} = require('./src/components/mca/platform/tables.tsx');
    const render = (path, enabled) => renderToStaticMarkup(React.createElement(ThemeProvider, null,
      React.createElement(AppRouterContext.Provider, {value:{refresh(){}}}, React.createElement(PathnameContext.Provider, {value:path}, React.createElement(PlatformChrome,
        {email:'operator@example.test',roadmapEnabled:enabled}, React.createElement('h1',null,'Synthetic page'))))));
    const {default:SmsReview} = require('./src/components/mca/platform/sms-review.tsx');
    const smsLoading = renderToStaticMarkup(React.createElement(SmsReview));
    const totals = renderToStaticMarkup(React.createElement(CurrencyTotals, {cards:true,totals:[
      {currency:'usd',due:'10000',paid:'5000',remaining:'5000',refunded:'0',disputed:'0'},
      {currency:'eur',due:'20000',paid:'10000',remaining:'10000',refunded:'0',disputed:'0'}]}));
    console.log(JSON.stringify([render('/platform',false),render('/platform/companies/company-a',true),totals,smsLoading]));
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const [overview, detail, totals, smsLoading] = JSON.parse(result.stdout) as string[]
  for (const url of ["/platform/companies", "/platform/payments", "/platform/monitoring", "/platform/onboarding", "/platform/sms", "/platform/audit", "/platform/demo-requests", "/account-security", "/dashboard"]) assert.ok(overview.includes(`href="${url}"`), url)
  assert.doesNotMatch(overview, /href="\/platform\/roadmap"/)
  assert.match(detail, /href="\/platform\/roadmap"/)
  assert.match(detail, /data-active="true"[^>]*href="\/platform\/companies"/)
  assert.doesNotMatch(detail, /data-active="true"[^>]*href="\/platform"/)
  assert.match(detail, /operator@example.test/)
  assert.match(detail, /<main[^>]*id="platform-content"/)
  assert.match(totals, />USD<\/h3>/)
  assert.match(totals, />EUR<\/h3>/)
  assert.match(totals, /not net revenue/)
  assert.match(totals, /across all pages/)
  assert.match(smsLoading, /Loading SMS reviews/)
  assert.doesNotMatch(smsLoading, /No companies available for review/)
})
