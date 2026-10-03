import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("criteria panel resets a rule's unit to months when its field changes to Term", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const { withRuleField } = require('./src/components/mca/funders/criteria-panel.tsx');
    const base = { key: 'k', field: 'requested_amount', operator: 'max', unit: 'usd', value: '180', sourceText: '', sourceAsOf: '', validUntil: '', unspecified: false };
    const term = withRuleField(base, 'term');
    const termAgain = withRuleField({ ...term, unit: 'days' }, 'term');
    const back = withRuleField(term, 'fico');
    console.log(JSON.stringify({ term, termAgain, back }));
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const { term, termAgain, back } = JSON.parse(result.stdout.trim())
  assert.equal(term.field, "term")
  assert.equal(term.unit, "months")
  assert.equal(term.value, "180", "only the unit is reset")
  assert.equal(termAgain.unit, "days", "re-selecting Term keeps a unit the broker chose for it")
  assert.equal(back.field, "fico")
  assert.equal(back.unit, "months", "other fields keep their unit as before")
})
