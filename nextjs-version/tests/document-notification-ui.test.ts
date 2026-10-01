import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
test('document alerts show explicit freshness, unresolved requests and delivery uncertainty',()=>{
 const script=`const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');const {DocumentNotificationList,documentNotificationStatus}=require('./src/components/mca/documents/document-notifications');const snapshot={dealId:'deal',asOf:'2026-10-01T00:00:00Z',requiredStatementPeriod:'2026-09',conditions:[{key:'stale:statement:2026-09',reason:'stale',category:'statement',label:'Bank statement',requiredPeriod:'2026-09'}],links:[]};console.log(JSON.stringify({html:renderToStaticMarkup(React.createElement(DocumentNotificationList,{snapshot,onSelect:()=>{}})),queued:documentNotificationStatus({broker:{state:'queued'}}),uncertain:documentNotificationStatus({broker:{state:'uncertain'}}),blocked:documentNotificationStatus({merchant:{state:'blocked',errorCode:'notification_consent_required'}})}));`
 const child=spawnSync(process.execPath,['--import','tsx','-e',script],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}})
 assert.equal(child.status,0,child.stderr)
 const result=JSON.parse(child.stdout)
 assert.match(result.html,/2026-09/);assert.match(result.html,/completed UTC month/);assert.match(result.html,/Stale/)
 assert.match(result.queued,/Queued/);assert.ok(!result.queued.includes('sent'))
 assert.match(result.uncertain,/unknown/);assert.match(result.blocked,/consent/)
})
