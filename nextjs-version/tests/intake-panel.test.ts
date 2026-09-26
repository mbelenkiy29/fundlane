import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

test("Send receipts stays disabled when delivery is unavailable, including the unset flag path", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { ReceiptSendControl } = require('./src/components/mca/intake/intake-panel.tsx');
    console.log(JSON.stringify([[false, false], [true, false], [true, true]].map(([deliveryEnabled, busy]) =>
      renderToStaticMarkup(React.createElement(ReceiptSendControl, { deliveryEnabled, busy, onSend() {} }))
    )));
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const [unavailable, available, busy] = JSON.parse(result.stdout) as string[]
  assert.match(unavailable, /<button[^>]*disabled=""[^>]*>.*Send receipts<\/button>/)
  assert.match(unavailable, /Private email receipt delivery is unavailable/)
  assert.match(available, /<button[^>]*>.*Send receipts<\/button>/)
  assert.doesNotMatch(available, /<button[^>]*\sdisabled(?:=|\s|>)/)
  assert.doesNotMatch(available, /Private email receipt delivery is unavailable/)
  assert.match(busy, /<button[^>]*disabled=""[^>]*>.*Send receipts<\/button>/)
})
