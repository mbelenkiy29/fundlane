import test from 'node:test'
import assert from 'node:assert/strict'
import { previousCompletedUtcMonth, deriveDocumentConditions, type DocumentNotificationFacts } from '../src/lib/mca/documents/notification-facts'
const clock='2026-10-01T00:00:00.000Z'
const document=(id='doc',state='clean',category='statement',version=1,lineageId='lineage')=>({id,processingState:state,category,version,lineageId,createdAt:clock})
const facts=(overrides:Partial<DocumentNotificationFacts>={}):DocumentNotificationFacts=>({dealId:'deal',status:'new_application',clock,documents:[],periods:[],stipulations:[],...overrides})
test('previous completed UTC month handles year/leap/timezone boundaries',()=>{
 for(const [at,period] of [[clock,'2026-09'],['2026-01-01T00:00:00Z','2025-12'],['2024-03-01T00:00:00Z','2024-02'],['2026-09-30T23:59:59.999Z','2026-08'],['2026-10-01T00:30:00+02:00','2026-08']])assert.equal(previousCompletedUtcMonth(at),period)
 assert.throws(()=>previousCompletedUtcMonth('bad'))
})
test('unscanned validation-only ready and failed uploads stay missing',()=>{
 for(const state of ['ready','pending_scan','pending_upload','upload_failed','scan_failed','quarantined'])assert.ok(deriveDocumentConditions(facts({documents:[document('doc',state)],periods:[{documentId:'doc',period:'2026-09'}]})).some(item=>item.reason==='missing'&&item.category==='statement'),state)
 assert.ok(!deriveDocumentConditions(facts({documents:[document()],periods:[{documentId:'doc',period:'2026-09'}]})).some(item=>item.category==='statement'))
})
test('statement freshness uses period instead of upload date or future/malformed metadata',()=>{
 for(const period of ['2026-08','2026-10','2026-13','nonsense'])assert.ok(deriveDocumentConditions(facts({documents:[document()],periods:[{documentId:'doc',period}]})).some(item=>item.reason==='stale'&&item.requiredPeriod==='2026-09'))
 assert.ok(deriveDocumentConditions(facts({documents:[document()],periods:[]})).some(item=>item.reason==='stale'))
 assert.ok(deriveDocumentConditions(facts({documents:[document()],periods:[{documentId:'doc',period:'2026-09',duplicateOfId:'other'}]})).some(item=>item.reason==='stale'))
})
test('latest unsafe lineage version prevents old clean version satisfying requirement',()=>{
 assert.ok(deriveDocumentConditions(facts({documents:[document('old'),document('new','pending_scan','statement',2)],periods:[{documentId:'old',period:'2026-09'}]})).some(item=>item.reason==='missing'&&item.category==='statement'))
})
test('requests require clean linked document or verified/waived status',()=>{
 for(const status of ['open','received'] as const){
  const stip={id:'stip',category:'other_stip',label:'Requested tax return',status,linkedDocumentId:'request-doc'}
  assert.ok(deriveDocumentConditions(facts({stipulations:[stip],documents:[document('request-doc','pending_scan','other_stip')]})).some(item=>item.reason==='requested'&&item.stipulationId==='stip'))
  assert.ok(!deriveDocumentConditions(facts({stipulations:[stip],documents:[document('request-doc','clean','other_stip')]})).some(item=>item.reason==='requested'))
 }
 for(const status of ['verified','waived'] as const)assert.ok(!deriveDocumentConditions(facts({stipulations:[{id:'stip',category:'other_stip',label:'Tax return',status}]})).some(item=>item.reason==='requested'))
})
test('closed and funded deals suppress document alerts',()=>{for(const status of ['closed','funded'])assert.deepEqual(deriveDocumentConditions(facts({status})),[])})
