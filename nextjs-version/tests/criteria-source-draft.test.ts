import test from "node:test"
import assert from "node:assert/strict"
import { sourceDraft, sourcePayload } from "../src/lib/mca/funders/criteria-source-draft"
test("criteria editors preserve source facts through scan review and save", () => {
  const source={sourceText:"Synthetic expired rule",sourceAsOf:"2026-01-01",validUntil:"2026-09-01"}
  assert.deepEqual(sourcePayload(sourceDraft(source)),source)
  assert.deepEqual(sourcePayload(sourceDraft({})),{sourceText:undefined,sourceAsOf:undefined,validUntil:undefined})
})
