import "server-only"

import { extname } from "node:path"
import { AppError } from "../errors"
import type { DealActor, DealWriteInput } from "../deals/schema"
import { getDealForDocument, updateDealRecord } from "../deals/service"
import { extractApplication } from "../documents/extraction"
import { storeDocument } from "../documents/service"
import { extractConfirmedArchiveFiles, inspectArchives } from "./archive"
import type { ArchiveCategory, ArchiveEntryPreview } from "./contracts"
import { assertArchiveCategory } from "./category"
import { findImportRow, findPreview, recordArchiveAssociation } from "./repository"

function mimeType(filename:string):string{const extension=extname(filename).toLocaleLowerCase();if(extension===".pdf")return"application/pdf";if(extension===".png")return"image/png";if(extension===".jpg"||extension===".jpeg")return"image/jpeg";throw new AppError(415,"unsupported_document_type",`${filename} is not a PDF, PNG, or JPEG document.`)}

export async function previewArchiveMatches(actor:DealActor,input:{runId:string;archives:Array<{filename:string;bytes:Uint8Array}>}):Promise<ArchiveEntryPreview[]>{const preview=await findPreview(actor.workspaceId,input.runId);if(!preview)throw new AppError(404,"import_run_not_found","The import run was not found.");return inspectArchives(input.archives,preview.rows)}

function blankMerge(current:Awaited<ReturnType<typeof getDealForDocument>>,extracted:DealWriteInput):DealWriteInput{const merged:Record<string,unknown>={fieldSource:"application_scan"};for(const [key,value] of Object.entries(extracted)){if(value===undefined||key==="owners"||key==="assignments"||key==="fieldSource")continue;if(key==="address"){const address:Record<string,unknown>={};for(const [part,partValue] of Object.entries(value as Record<string,unknown>))if(!current.address?.[part as keyof NonNullable<typeof current.address>]&&partValue)address[part]=partValue;if(Object.keys(address).length)merged.address={...(current.address??{}),...address};continue}if(!(current as unknown as Record<string,unknown>)[key])merged[key]=value}return merged as DealWriteInput}

export async function applyArchiveMatches(actor:DealActor,input:{runId:string;archives:Array<{filename:string;bytes:Uint8Array}>;confirmations:Array<{archiveName:string;path:string;rowId:string;category:ArchiveCategory}>}):Promise<{stored:number;enriched:number;warnings:string[]}>{const preview=await findPreview(actor.workspaceId,input.runId);if(!preview||preview.state!=="completed")throw new AppError(409,"import_not_completed","Commit the spreadsheet import before attaching confirmed documents.");const validRows=new Set(preview.rows.map((row)=>row.id));for(const item of input.confirmations){assertArchiveCategory(item.category);if(!validRows.has(item.rowId))throw new AppError(404,"import_row_not_found","A confirmed document references an unavailable import row.")}
  const files=await extractConfirmedArchiveFiles(input.archives,input.confirmations);let stored=0,enriched=0;const warnings:string[]=[]
  for(const file of files){const row=await findImportRow(actor.workspaceId,input.runId,file.rowId);if(!row?.dealId)throw new AppError(409,"import_row_uncommitted",`Row ${file.rowId} does not have a committed deal.`);const document=await storeDocument(actor,{dealId:row.dealId,idempotencyKey:`import:${input.runId}:${file.archiveName}:${file.path}`,filename:file.filename,mimeType:mimeType(file.filename),bytes:file.bytes,category:file.category,source:"import_zip",sourceReference:`${input.runId}:${file.archiveName}:${file.path}`});await recordArchiveAssociation({workspaceId:actor.workspaceId,runId:input.runId,rowId:file.rowId,archiveName:file.archiveName,path:file.path,category:file.category,documentId:document.id});stored++
    if(file.category==="application"){if(document.processingState!=="clean"){warnings.push(`${file.filename} was stored but enrichment is waiting for a clean malware scan.`);continue}try{const extraction=await extractApplication(actor,{filename:file.filename,mimeType:mimeType(file.filename),bytes:file.bytes,sourceReference:`import:${input.runId}:${file.rowId}`});const current=await getDealForDocument(actor,row.dealId);const changes=blankMerge(current,extraction.fields);if(Object.keys(changes).some((key)=>key!=="fieldSource")){await updateDealRecord(actor,row.dealId,{...changes,expectedVersion:current.version});enriched++}}catch(error){warnings.push(error instanceof Error&&error.message.includes("provider_unavailable")?`${file.filename} is clean, but AI enrichment is not configured.`:`${file.filename} enrichment failed and can be retried.`)}}}
  return{stored,enriched,warnings}}
