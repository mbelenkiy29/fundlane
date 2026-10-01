import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

test("queue presents loading, empty, denied/error and stale snapshot states with accessible controls",()=>{
 const result=spawnSync(process.execPath,["--import","tsx","-e",`
 const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
 const {OperationsQueueResults}=require('./src/components/mca/platform/operations-queues.tsx');
 const row={workspaceId:'company-a',name:'Company A',ownerEmail:null,occupiedSeats:1,purchasedSeats:2,subscriptionStatus:'active',accessState:'active',smsReviewState:'pending',providerState:'unknown',observedAt:null,blockedReasons:['provider_observation_unverified']};
 const props=[{loading:true},{page:{items:[],nextCursor:null}},{error:'Could not load queue.'},{page:{items:[row],nextCursor:'next'},error:'Refresh failed.',loadedAt:'2026-01-01T00:00:00.000Z'}];
 console.log(JSON.stringify(props.map(p=>renderToStaticMarkup(React.createElement(OperationsQueueResults,{kind:'companies',...p})))));
 `],{encoding:"utf8"})
 assert.equal(result.status,0,result.stderr)
 const [loading,empty,error,stale]=JSON.parse(result.stdout) as string[]
 assert.match(loading,/role="status"/);assert.match(loading,/Loading/)
 assert.match(empty,/No matching/);assert.doesNotMatch(empty,/<table/)
 assert.match(error,/role="alert"/)
 assert.match(stale,/Stale snapshot/);assert.match(stale,/href="\/platform\/companies\/company-a"/)
 assert.match(stale,/tabindex="0"/);assert.match(stale,/overflow-auto/);assert.match(stale,/unknown/)
})
