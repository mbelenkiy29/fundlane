import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

function render(origin: string | null) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { LegacySmsWebhookDetails } = require('./src/components/mca/sms/sms-connections-panel.tsx');
    console.log(renderToStaticMarkup(React.createElement(LegacySmsWebhookDetails, { accountId: 'account-123', publicOrigin: ${JSON.stringify(origin)} })));
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test("legacy sender shows its account ID and both copyable apex webhooks", () => {
  const html = render("https://fundlane.io")
  assert.match(html, /value="account-123"/)
  assert.match(html, /value="https:\/\/fundlane.io\/api\/mca\/sms\/webhooks\/twilio\/account-123\/inbound"/)
  assert.match(html, /value="https:\/\/fundlane.io\/api\/mca\/sms\/webhooks\/twilio\/account-123\/status"/)
  assert.equal((html.match(/>Copy</g) ?? []).length, 2)
})

test("legacy sender renders a configuration message when the public origin is unavailable", () => {
  const html = render(null)
  assert.match(html, /value="account-123"/)
  assert.match(html, /Configure MCA_SMS_PUBLIC_BASE_URL/)
  assert.doesNotMatch(html, /\/inbound|\/status/)
})
