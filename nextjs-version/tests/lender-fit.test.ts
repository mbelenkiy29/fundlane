import test from "node:test"
import assert from "node:assert/strict"
import { criteriaReadiness } from "../src/lib/mca/funders/criteria-readiness"
import { projectLenderFit } from "../src/lib/mca/underwriting/lender-fit-projection"
import type { EligibilityRule, FunderRecord } from "../src/lib/mca/funders/contracts"
import type { FunderScore } from "../src/lib/mca/underwriting/contracts"
const rule: EligibilityRule = { id:"r", funderId:"f", field:"fico", operator:"min", unit:"fico", value:600, unspecified:false, sourceText:"Synthetic lender policy", sourceAsOf:"2026-09-01", validUntil:"2026-10-01" }
const funder: FunderRecord = { id:"f", workspaceId:"w", legalName:"Fixture", domains:[], products:[], active:true, contacts:[], routes:[], criteriaVersion:2, profileVersion:1, createdAt:"2026-09-01", updatedAt:"2026-09-01" }
const score: FunderScore = { funderId:"f", rank:1, score:80, grade:"A", eligible:true, fitStatus:"matched", reasons:[] }
const base = { asOf:"2026-10-01T12:00:00Z", funders:[funder], criteria:{f:[rule]}, scores:[score], snapshotId:"snapshot", scoredAt:"2026-10-01T10:00:00Z", stale:false, staleReasons:[], policyVersion:3, underwritingVersion:2 }
test("criteria expiry inclusive with explicit clock", () => {
  assert.equal(criteriaReadiness([rule],base.asOf).status,"ready")
  assert.equal(criteriaReadiness([rule],"2026-10-02T00:00:00Z").status,"stale_criteria")
  assert.equal(criteriaReadiness([{...rule,sourceAsOf:"2026-10-02"}],base.asOf).status,"needs_review")
})
test("no, unspecified and missing provenance explicit", () => {
  assert.deepEqual(criteriaReadiness([],base.asOf).missingData,["criteria"])
  assert.equal(criteriaReadiness([{...rule,unspecified:true,value:null}],base.asOf).status,"needs_review")
  assert.equal(criteriaReadiness([{...rule,sourceText:undefined,sourceAsOf:undefined}],base.asOf).status,"needs_review")
})
test("stale numeric fit not current", () => {
  const fit = projectLenderFit({...base,stale:true,staleReasons:["deal version changed"]})
  assert.equal(fit.contractVersion,1)
  assert.equal(fit.brokerSelectionRequired,true)
  assert.equal(fit.lenders[0].status,"needs_review")
  assert.equal(fit.lenders[0].score,null)
  assert.equal(fit.lenders[0].rank,null)
})
test("expiry after scoring and inactive explained without rescoring", () => {
  assert.equal(projectLenderFit({...base,asOf:"2026-10-02T00:00:00Z"}).lenders[0].status,"stale_criteria")
  assert.equal(projectLenderFit({...base,funders:[{...funder,active:false}]}).lenders[0].status,"inactive")
})
test("legacy and absent snapshot cannot imply matched", () => {
  assert.equal(projectLenderFit({...base,scores:[{...score,fitStatus:undefined}]}).lenders[0].status,"needs_review")
  assert.equal(projectLenderFit({...base,snapshotId:null,scores:[]}).lenders[0].status,"unscored")
})
test("deterministic match includes actual versioned facts", () => {
  const result=projectLenderFit(base)
  assert.equal(result.lenders[0].status,"matched")
  assert.equal(result.lenders[0].criteria.rules[0].sourceAsOf,"2026-09-01")
  assert.equal(result.lenders[0].criteriaVersion,2)
  assert.deepEqual(projectLenderFit(base),result)
  const additional={...funder,id:"a"}
  assert.deepEqual(projectLenderFit({...base,funders:[funder,additional]}),projectLenderFit({...base,funders:[additional,funder]}))
})
