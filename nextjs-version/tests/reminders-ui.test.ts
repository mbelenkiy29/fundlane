import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

test("reminders explain unavailable delivery separately from answered or unsent submissions", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react'); const { renderToStaticMarkup } = require('react-dom/server');
    const { ReminderDeliveryUnavailable } = require('./src/components/mca/comms/remind-funder.tsx');
    const blocked = {jobId:'blocked',displayFunderName:'Alpha Capital',ineligibleReason:'delivery_unconfigured'};
    const answered = {jobId:'answered',displayFunderName:'Answered Capital',ineligibleReason:'has_response'};
    const pending = {jobId:'pending',displayFunderName:'Pending Capital',ineligibleReason:'not_sent'};
    console.log(JSON.stringify([
      renderToStaticMarkup(React.createElement(ReminderDeliveryUnavailable,{jobs:[blocked,answered,pending]})),
      renderToStaticMarkup(React.createElement(ReminderDeliveryUnavailable,{jobs:[answered,pending]}))
    ]));
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const [blocked, ordinary] = JSON.parse(result.stdout) as string[]
  assert.match(blocked, /role="status"/)
  assert.match(blocked, /Reminder delivery is unavailable/)
  assert.match(blocked, /Alpha Capital/)
  assert.match(blocked, /Contact your administrator/)
  assert.doesNotMatch(blocked, /Answered Capital|Pending Capital/)
  assert.equal(ordinary, "")
})
