import "server-only"

import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent } from "../db"
import type { DealTransactionCheckpoint } from "../deals/repository"
import type { DealActor, DealStatus, DealWriteInput } from "../deals/schema"
import { DEAL_STATUSES } from "../deals/schema"
import { applyBulkDealUpdate, getDealForDocument, listDeals } from "../deals/service"
import { suggestFieldMapping } from "../documents/extraction"
import { ingestApplication } from "../intake/service"
import { listMemberships } from "../memberships"
import { validateAssignmentPool } from "./assignment"
import type { ImportCommitResult, ImportPreview, ImportSource, ImportableField, LeadBatch, MappingProfile, UpdatePreview, UpdateRowPreview } from "./contracts"
import { IMPORTABLE_FIELDS } from "./contracts"
import { assertMapping, heuristicMapping, mapRow, normalizeHeader } from "./mapping"
import { parseSpreadsheet } from "./parser"
import {
  applyCreateReview, batchesFor, beginCommit, findBatch, findPreview, findSource, findUpdatePreview,
  finishRun, insertBatch, insertPreview, insertSource, insertUpdatePreview, profilesFor, recordRowResult, recordRowResultInTransaction,
  requestCancellation, rowResultsForRun, sourcesFor, storedRunResult, upsertProfile,
} from "./repository"

function requireAdmin(actor: DealActor): void {
  if (!actor.role || !["admin", "super_admin"].includes(actor.role)) throw new AppError(403, "permission_denied", "Only workspace administrators can configure import sources and batches.")
}
async function refreshedActor(actor: DealActor): Promise<DealActor> { return { ...actor, activeMembershipIds: (await listMemberships(actor.workspaceId)).filter((member) => member.status === "active").map((member) => member.id) } }

function cleanName(value: string, label: string): string {
  const name = value.trim()
  if (!name || name.length > 120) throw new AppError(422, "validation_failed", `${label} must contain 1 to 120 characters.`)
  return name
}

async function sourceAndBatch(actor: DealActor, sourceId: string, batchId: string): Promise<{ source: ImportSource; batch: LeadBatch }> {
  const [source, batch] = await Promise.all([findSource(actor.workspaceId, sourceId), findBatch(actor.workspaceId, batchId)])
  if (!source || !source.active || !batch || batch.sourceId !== source.id) throw new AppError(404, "import_registry_not_found", "Choose an active source and a batch that belongs to it.")
  return { source, batch }
}

export async function createImportSource(actor: DealActor, input: { name: string; kind?: ImportSource["kind"] }): Promise<ImportSource> {
  requireAdmin(actor)
  const item = await insertSource(actor.workspaceId, cleanName(input.name, "Source name"), input.kind ?? "spreadsheet")
  await recordAuditEvent({ context: actor, action: "import.source_created", resourceType: "import_source", resourceId: item.id, metadata: { kind: item.kind }, correlationId: actor.correlationId })
  return item
}

export async function listImportRegistry(actor: DealActor): Promise<{ sources: ImportSource[]; batches: LeadBatch[]; profiles: MappingProfile[] }> {
  requireAdmin(actor)
  const [sources, batches, profiles] = await Promise.all([sourcesFor(actor.workspaceId), batchesFor(actor.workspaceId), profilesFor(actor.workspaceId)])
  return { sources, batches, profiles }
}

export async function createLeadBatch(actor: DealActor, input: { sourceId: string; name: string }): Promise<LeadBatch> {
  requireAdmin(actor)
  const source = await findSource(actor.workspaceId, input.sourceId)
  if (!source || !source.active) throw new AppError(404, "import_source_not_found", "The selected source was not found.")
  const item = await insertBatch(actor.workspaceId, source.id, cleanName(input.name, "Batch name"))
  await recordAuditEvent({ context: actor, action: "import.batch_created", resourceType: "lead_batch", resourceId: item.id, metadata: { sourceId: source.id }, correlationId: actor.correlationId })
  return item
}

export async function saveMappingProfile(actor: DealActor, input: { name: string; mapping: Record<string, string>; originatorMapping?:Record<string,string> }): Promise<MappingProfile> {
  requireAdmin(actor)
  const allowed = new Set<string>(IMPORTABLE_FIELDS)
  const mapping = Object.fromEntries(Object.entries(input.mapping).filter(([, value]) => allowed.has(value))) as Record<string, ImportableField>
  const originatorMapping=Object.fromEntries(Object.entries(input.originatorMapping??{}).map(([label,id])=>[label.trim(),validateAssignmentPool(actor,[id])[0]]).filter(([label])=>label))
  return upsertProfile(actor.workspaceId, cleanName(input.name, "Profile name"), mapping, originatorMapping)
}

async function duplicateIds(actor: DealActor, application: DealWriteInput): Promise<string[]> {
  const candidates = new Set([application.legalName, application.dbaName].filter(Boolean).map((value) => normalizeHeader(String(value))))
  if (!candidates.size) return []
  return (await listDeals(actor, {})).deals.filter((deal) => candidates.has(normalizeHeader(deal.legalName)) || (deal.dbaName && candidates.has(normalizeHeader(deal.dbaName)))).map((deal) => deal.id)
}

export async function previewSpreadsheetImport(actor: DealActor, input: {
  sourceId: string; batchId: string; filename: string; bytes: Uint8Array; mapping?: Record<string, string>;
  useAiMapping?: boolean; assignmentPool?: string[]; originatorMapping?:Record<string,string>
}): Promise<ImportPreview> {
  requireAdmin(actor)
  await sourceAndBatch(actor, input.sourceId, input.batchId)
  const parsed = parseSpreadsheet({ filename: input.filename, bytes: input.bytes })
  const heuristic = heuristicMapping(parsed.headers)
  let mapping = input.mapping ? assertMapping(input.mapping, parsed.headers) : heuristic.mapping
  let confidence: Record<string, number> = input.mapping ? Object.fromEntries(Object.keys(mapping).map((key) => [key, 1])) : heuristic.confidence
  let mappingProvider = input.mapping ? "manual" : "manual_heuristic"
  const mappingWarnings = [...parsed.warnings]
  if (input.useAiMapping) {
    try {
      const suggested = await suggestFieldMapping(actor, { headers: parsed.headers, samples: parsed.rows.slice(0, 5), allowedFields: [...IMPORTABLE_FIELDS] })
      mapping = assertMapping(suggested.mapping, parsed.headers)
      confidence = Object.fromEntries(Object.entries(suggested.confidence).filter(([key]) => key in mapping))
      mappingProvider = suggested.provider
      mappingWarnings.push(...suggested.warnings)
    } catch (error) {
      mappingWarnings.push(error instanceof Error && error.message.includes("provider_unavailable")
        ? "AI mapping is not configured. Manual mapping remains available."
        : "AI mapping failed. Review the manual suggestions before continuing.")
      mappingProvider = "manual_heuristic"
    }
  }
  const pool = validateAssignmentPool(actor, input.assignmentPool ?? [])
  const mapped = parsed.rows.map((row) => mapRow(parsed.headers, row, mapping))
  const active=(await listMemberships(actor.workspaceId)).filter((member)=>member.status==="active")
  const byExternal=new Map<string,string>();for(const member of active)for(const label of [member.id,member.name,member.email,member.applicationIdentifier])if(label)byExternal.set(normalizeHeader(label),member.id)
  for(const [label,id] of Object.entries(input.originatorMapping??{}))byExternal.set(normalizeHeader(label),validateAssignmentPool(actor,[id])[0])
  let cursor=0;const assignments=mapped.map((row)=>{if(row.explicitOriginator)return byExternal.get(normalizeHeader(row.explicitOriginator))??null;if(!pool.length)return null;const id=pool[cursor%pool.length];cursor++;return id})
  const createdAt = nowIso()
  const preview: ImportPreview = {
    runId: newId(), workspaceId: actor.workspaceId, sourceId: input.sourceId, batchId: input.batchId,
    filename: input.filename, format: parsed.format, state: "preview", previewRevision: 1, mapping,
    mappingConfidence: confidence, mappingProvider, mappingWarnings, assignmentPool: pool, createdAt,
    rows: await Promise.all(mapped.map(async (row, index) => {
      const duplicateDealIds = await duplicateIds(actor, row.application)
      const warnings=[...(duplicateDealIds.length?["Choose whether to create this possible duplicate or skip it."]:[]),...(row.explicitOriginator&&!assignments[index]?["Resolve the source originator to an active member."]:[])]
      return { id: newId(), rowNumber: parsed.headerRow + index + 1, application: row.application, sourceValues: row.sourceValues,
        assignmentMembershipId: assignments[index], originatorSourceValue:row.explicitOriginator??null,duplicateDecision:duplicateDealIds.length?null:"create",errors: row.errors, warnings, duplicateDealIds }
    })),
  }
  await insertPreview(preview)
  await recordAuditEvent({ context: actor, action: "import.previewed", resourceType: "import_run", resourceId: preview.runId, metadata: { sourceId: input.sourceId, batchId: input.batchId, format: preview.format, rowCount: preview.rows.length, mappingProvider }, correlationId: actor.correlationId })
  return preview
}

export async function reviewSpreadsheetImport(actor:DealActor,input:{runId:string;expectedPreviewRevision:number;decisions:Array<{rowId:string;duplicateDecision?:"create"|"skip";assignmentMembershipId?:string}>}):Promise<ImportPreview>{requireAdmin(actor);const preview=await findPreview(actor.workspaceId,input.runId);if(!preview)throw new AppError(404,"import_run_not_found","The import run was not found.");const ids=new Set(preview.rows.map((row)=>row.id));const activeActor=await refreshedActor(actor);for(const decision of input.decisions){if(!ids.has(decision.rowId))throw new AppError(404,"import_row_not_found","A reviewed row is not part of this preview.");if(decision.assignmentMembershipId)validateAssignmentPool(activeActor,[decision.assignmentMembershipId])}const updated=await applyCreateReview(actor.workspaceId,input.runId,input.expectedPreviewRevision,input.decisions);if(!updated)throw new AppError(409,"import_preview_stale","The preview changed. Refresh before saving review decisions.");return updated}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value)
  const safe = /^[=+@\-\t\r]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(safe) ? `"${safe.split('"').join('""')}"` : safe
}
async function recordCommittedRow(workspaceId:string,runId:string,rowId:string,state:string,dealId:string|null,message:string|null,commitToken:string):Promise<void>{if(!await recordRowResult(workspaceId,runId,rowId,state,dealId,message,commitToken))throw new AppError(409,"import_commit_lease_lost","Another worker reclaimed this import. This worker stopped before changing its checkpoints.")}

export async function commitSpreadsheetImport(actor: DealActor, input: { runId: string; expectedPreviewRevision: number }): Promise<ImportCommitResult> {
  requireAdmin(actor)
  actor=await refreshedActor(actor)
  const preview = await findPreview(actor.workspaceId, input.runId)
  if (!preview) throw new AppError(404, "import_run_not_found", "The import run was not found.")
  await sourceAndBatch(actor, preview.sourceId, preview.batchId)
  validateAssignmentPool(actor, preview.assignmentPool)
  for (const row of preview.rows) if (row.assignmentMembershipId) validateAssignmentPool(actor, [row.assignmentMembershipId])
  if (preview.state === "completed") return await storedRunResult(actor.workspaceId, preview.runId) ?? { runId:preview.runId,state:"completed",created:0,skipped:0,failed:0,resultsCsv:"row,state,deal_id,message\r\n" }
  const commitToken=await beginCommit(actor.workspaceId, preview.runId, input.expectedPreviewRevision)
  if (!commitToken) {
    const latest = await findPreview(actor.workspaceId, preview.runId)
    if (latest?.state === "cancelled") return { runId: preview.runId, state: "cancelled", created: 0, skipped: preview.rows.length, failed: 0, resultsCsv: "row,state,deal_id,message\r\n" }
    if(latest?.state==="committing")throw new AppError(409,"import_commit_in_progress","This import still has an active commit lease. Refresh its status; if the worker stopped, retry after two minutes.")
    throw new AppError(409, "import_preview_stale", "The import preview changed or was already committed. Refresh before continuing.")
  }
  let created = 0, skipped = 0, failed = 0
  const results: string[][] = [["row", "state", "deal_id", "message"]]
  const checkpoints = await rowResultsForRun(actor.workspaceId, preview.runId)
  for (const row of preview.rows) {
    const checkpoint=checkpoints.get(row.id)
    if(checkpoint&&["created","retried","skipped"].includes(checkpoint.state)){if(checkpoint.state==="created")created++;else skipped++;results.push([String(row.rowNumber),checkpoint.state,checkpoint.dealId??"",checkpoint.message??""]);continue}
    const currentDuplicates=await duplicateIds(actor,row.application)
    const duplicateChanged=currentDuplicates.some((id)=>!row.duplicateDealIds.includes(id))
    if (row.errors.length || row.duplicateDecision!=="create" || duplicateChanged || (row.originatorSourceValue&&!row.assignmentMembershipId)) {
      skipped += 1; const message = row.errors.join(" ") || (duplicateChanged?"A possible duplicate appeared after preview; refresh and review.":row.duplicateDecision==="skip"?"Skipped by duplicate review.":row.originatorSourceValue&&!row.assignmentMembershipId?"Originator mapping is unresolved.":"Possible duplicate requires an explicit create or skip decision.")
      await recordCommittedRow(actor.workspaceId, preview.runId, row.id, "skipped", null, message,commitToken); results.push([String(row.rowNumber), "skipped", "", message]); continue
    }
    try {
      const application: DealWriteInput = { ...row.application, ...(row.assignmentMembershipId ? { assignments: [{ membershipId: row.assignmentMembershipId, kind: "originator", isPrimary: true }] } : {}) }
      const checkpoint: DealTransactionCheckpoint = async (tx, persisted, dealOutcome) => {
        const state = dealOutcome === "created" ? "created" : "retried"
        if (!await recordRowResultInTransaction(tx, actor.workspaceId, preview.runId, row.id, state, persisted.id, null, commitToken)) throw new AppError(409,"import_commit_lease_lost","Another worker reclaimed this import before its deal change.")
      }
      const outcome = await ingestApplication(actor, { schemaVersion: 1, provider: "import", eventId: `${preview.batchId}:${row.id}`, application, sourceReference: `import:${preview.runId}:${row.rowNumber}` }, checkpoint)
      if (!outcome.dealId) throw new Error(outcome.warnings.join(" ") || "The intake did not create a deal.")
      if (outcome.created) created += 1; else skipped += 1
      const state = outcome.created ? "created" : "retried"
      results.push([String(row.rowNumber), state, outcome.dealId, outcome.warnings.join(" ")])
    } catch (error) {
      if(error instanceof AppError&&error.code==="import_commit_lease_lost")throw error
      failed += 1; const message = error instanceof Error ? error.message : "Unknown row error"
      await recordCommittedRow(actor.workspaceId, preview.runId, row.id, "failed", null, message,commitToken); results.push([String(row.rowNumber), "failed", "", message])
    }
  }
  const result: ImportCommitResult = { runId: preview.runId, state: failed ? "failed" : "completed", created, skipped, failed, resultsCsv: results.map((row) => row.map(csvCell).join(",")).join("\r\n") }
  if(!await finishRun(actor.workspaceId, preview.runId, result,commitToken))throw new AppError(409,"import_commit_lease_lost","Another worker reclaimed this import before finalization. Refresh its status.")
  await recordAuditEvent({ context: actor, action: "import.committed", resourceType: "import_run", resourceId: preview.runId, metadata: { created, skipped, failed }, correlationId: actor.correlationId })
  return result
}

export async function cancelImport(actor: DealActor, runId: string): Promise<void> {
  requireAdmin(actor)
  if (!await requestCancellation(actor.workspaceId, runId)) throw new AppError(409, "import_not_cancellable", "Only an uncommitted preview can be cancelled.")
  await recordAuditEvent({ context: actor, action: "import.cancelled", resourceType: "import_run", resourceId: runId, metadata: {}, correlationId: actor.correlationId })
}

const updateFields = new Set(["legalName","dbaName","contactName","contactEmail","contactPhone","industry","naicsCode","monthlyRevenue","ficoScore","fundingPurpose","requestedAmount","address.line1","address.line2","address.city","address.state","address.postalCode","originatorMembershipId","status"])
const forbiddenUpdateTerms = /owner|offer|payment/i
export const updateCsvTemplate = "dealId,expectedVersion,legalName,dbaName,contactName,contactEmail,contactPhone,industry,naicsCode,monthlyRevenue,ficoScore,fundingPurpose,requestedAmount,address.line1,address.line2,address.city,address.state,address.postalCode,originatorMembershipId,status,clearFields\r\n"

function updateValue(field:string,raw:string):unknown { if (["monthlyRevenue","requestedAmount","ficoScore"].includes(field)) { const value=Number(raw.replace(/[$,\s]/g,"")); return Number.isFinite(value)?value:raw } return raw }

export async function previewCsvUpdate(actor: DealActor, input:{sourceId:string;batchId:string;filename:string;bytes:Uint8Array;mapping?:Record<string,string>}):Promise<UpdatePreview> {
  requireAdmin(actor)
  await sourceAndBatch(actor,input.sourceId,input.batchId)
  const parsed=parseSpreadsheet({filename:input.filename,bytes:input.bytes})
  if(parsed.format!=="csv")throw new AppError(422,"update_format","Bulk updates accept CSV files.")
  const mapping=input.mapping??Object.fromEntries(parsed.headers.filter((header)=>updateFields.has(header)||["dealId","expectedVersion","clearFields"].includes(header)).map((header)=>[header,header]))
  for(const target of Object.values(mapping)){if(forbiddenUpdateTerms.test(target))throw new AppError(422,"update_field_forbidden",`The ${target} field cannot be changed by bulk update.`);if(!updateFields.has(target)&&!["dealId","expectedVersion","clearFields"].includes(target))throw new AppError(422,"update_field_forbidden",`The ${target} column is not allowed in bulk update.`)}
  const rows:UpdateRowPreview[]=await Promise.all(parsed.rows.map(async (values,index)=>{
    const source=Object.fromEntries(parsed.headers.map((header,column)=>[mapping[header],values[column]?.trim()??""]))
    const dealId=String(source.dealId??"");const expectedVersion=Number(source.expectedVersion);const errors:string[]=[];let deal:Awaited<ReturnType<typeof getDealForDocument>>|undefined
    if(!dealId)errors.push("A deal ID is required; blank IDs never create deals in update mode.")
    else try{deal=await getDealForDocument(actor,dealId)}catch{errors.push("The deal was not found in your authorized workspace.")}
    if(!Number.isInteger(expectedVersion)||expectedVersion<1)errors.push("A positive expectedVersion is required.")
    const clearFields=String(source.clearFields??"").split(/[|;]/).map((value)=>value.trim()).filter(Boolean)
    for(const field of clearFields)if(!updateFields.has(field)||field==="status"||field==="originatorMembershipId")errors.push(`${field} cannot be explicitly cleared.`)
    const changes:Record<string,unknown>={}
    for(const [field,rawValue] of Object.entries(source)){const raw=String(rawValue);if(!updateFields.has(field)||!raw)continue;if(field==="status"||field==="originatorMembershipId")continue;changes[field]=updateValue(field,raw)}
    for(const field of clearFields)changes[field]=null
    const status=source.status&&DEAL_STATUSES.includes(source.status as DealStatus)?source.status as DealStatus:undefined
    if(source.status&&!status)errors.push("Status is not recognized.")
    if(source.originatorMembershipId){try{validateAssignmentPool(actor,[source.originatorMembershipId]);changes.assignments=[{membershipId:source.originatorMembershipId,kind:"originator",isPrimary:true}]}catch(error){errors.push(error instanceof Error?error.message:"Invalid assignment.")}}
    const before=deal?Object.fromEntries(Object.keys(changes).map((field)=>[field,field.startsWith("address.")?deal?.address?.[field.slice(8) as keyof NonNullable<typeof deal.address>]:(deal as unknown as Record<string,unknown>)[field]])):{}
    if(deal&&status)before.status=deal.status
    return{id:newId(),rowNumber:parsed.headerRow+index+1,dealId,expectedVersion,before,changes,status,clearFields,errors}
  }))
  return insertUpdatePreview({workspaceId:actor.workspaceId,sourceId:input.sourceId,batchId:input.batchId,filename:input.filename,mapping,headers:parsed.headers,rows})
}

function nestedDealChanges(changes:Record<string,unknown>,current:Awaited<ReturnType<typeof getDealForDocument>>):DealWriteInput { const result:Record<string,unknown>={},address:Record<string,unknown>={...(current.address??{})};for(const [field,value] of Object.entries(changes)){const resolved=value===null?undefined:value;if(field.startsWith("address."))address[field.slice(8)]=resolved;else result[field]=resolved}if(Object.keys(changes).some((field)=>field.startsWith("address.")))result.address=address;return result as DealWriteInput }

export async function commitCsvUpdate(actor:DealActor,input:{runId:string;expectedPreviewRevision:number}):Promise<ImportCommitResult> {
  requireAdmin(actor)
  actor=await refreshedActor(actor)
  const preview=await findUpdatePreview(actor.workspaceId,input.runId);if(!preview)throw new AppError(404,"import_run_not_found","The update run was not found.")
  if(preview.state==="completed")return await storedRunResult(actor.workspaceId,input.runId)??{runId:input.runId,state:"completed",created:0,skipped:0,failed:0,resultsCsv:"row,state,deal_id,message\r\n"}
  const commitToken=await beginCommit(actor.workspaceId,input.runId,input.expectedPreviewRevision);if(!commitToken){const latest=await findUpdatePreview(actor.workspaceId,input.runId);if(latest?.state==="committing")throw new AppError(409,"import_commit_in_progress","This update still has an active commit lease. Retry after two minutes if its worker stopped.");throw new AppError(409,"import_preview_stale","The update preview changed or was already committed.")}
  let created=0,skipped=0,failed=0;const results=[["row","state","deal_id","message"]],checkpoints=await rowResultsForRun(actor.workspaceId,input.runId)
  for(const row of preview.rows){const checkpoint=checkpoints.get(row.id);if(checkpoint&&["updated","skipped"].includes(checkpoint.state)){if(checkpoint.state==="updated")created++;else skipped++;results.push([String(row.rowNumber),checkpoint.state,checkpoint.dealId??"",checkpoint.message??""]);continue}if(row.errors.length){skipped++;await recordCommittedRow(actor.workspaceId,input.runId,row.id,"skipped",null,row.errors.join(" "),commitToken);results.push([String(row.rowNumber),"skipped","",row.errors.join(" ")]);continue}
    try{const current=await getDealForDocument(actor,row.dealId);if(current.version!==row.expectedVersion)throw new AppError(409,"version_conflict","This deal changed after preview.");const next=await applyBulkDealUpdate(actor,row.dealId,{expectedVersion:row.expectedVersion,changes:nestedDealChanges(row.changes,current),status:row.status,reason:`Bulk update ${input.runId}`,transactionCheckpoint:async(database)=>{if(!await recordRowResultInTransaction(database,actor.workspaceId,input.runId,row.id,"updated",row.dealId,null,commitToken))throw new AppError(409,"import_commit_lease_lost","Another worker reclaimed this update before its deal change.")}})
      created++;results.push([String(row.rowNumber),"updated",next.id,""])
    }catch(error){if(error instanceof AppError&&error.code==="import_commit_lease_lost")throw error;failed++;const message=error instanceof Error?error.message:"Unknown row error";await recordCommittedRow(actor.workspaceId,input.runId,row.id,"failed",null,message,commitToken);results.push([String(row.rowNumber),"failed",row.dealId,message])}}
  const result:ImportCommitResult={runId:input.runId,state:failed?"failed":"completed",created,skipped,failed,resultsCsv:results.map((row)=>row.map(csvCell).join(",")).join("\r\n")};if(!await finishRun(actor.workspaceId,input.runId,result,commitToken))throw new AppError(409,"import_commit_lease_lost","Another worker reclaimed this update before finalization. Refresh its status.");return result
}

export async function importStatus(actor:DealActor,runId:string):Promise<ImportPreview|UpdatePreview> { requireAdmin(actor);const preview=await findPreview(actor.workspaceId,runId)??await findUpdatePreview(actor.workspaceId,runId);if(!preview)throw new AppError(404,"import_run_not_found","The import run was not found.");return preview }
