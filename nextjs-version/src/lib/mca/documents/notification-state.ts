import 'server-only'
import {z} from 'zod'
import {getDatabase,nowIso} from '../db'
import {getDealForDocument} from '../deals/service'
import type {DealActor} from '../deals/schema'
import {listDocumentRecords} from './repository'
import {deriveDocumentConditions,previousCompletedUtcMonth} from './notification-facts'
import {AppError} from '../errors'
import {decryptSensitive} from '../crypto'
import {merchantUploadBinding} from '../closing/service'

export const documentConditionKeySchema=z.object({dealId:z.string().min(1).max(80),key:z.string().min(1).max(200),linkId:z.string().min(1).max(80).optional()}).strict()
export type DocumentConditionKey=z.infer<typeof documentConditionKeySchema>
export async function documentNotificationFacts(actor:DealActor,dealId:string,clock=nowIso()){
 const deal=await getDealForDocument(actor,dealId)
 const [documents,periods,stipulations]=await Promise.all([
  listDocumentRecords(actor.workspaceId,dealId,true),
  getDatabase().prepare<{documentId:string;period:string;duplicateOfId?:string}>(`SELECT document_id AS "documentId",period,duplicate_of_id AS "duplicateOfId" FROM mca_statement_months WHERE workspace_id=? AND deal_id=?`).all(actor.workspaceId,dealId),
  getDatabase().prepare<{id:string;category:string;label:string;status:string;linkedDocumentId?:string}>(`SELECT id,document_category category,label,status,linked_document_id AS "linkedDocumentId" FROM mca_closing_stipulations WHERE workspace_id=? AND deal_id=?`).all(actor.workspaceId,dealId),
 ])
 return {dealId,status:deal.status,clock,documents,periods,stipulations}
}
export async function activeDocumentCondition(actor:DealActor,key:DocumentConditionKey,clock=nowIso()){
 const facts=await documentNotificationFacts(actor,key.dealId,clock)
 return deriveDocumentConditions(facts).find(condition=>condition.key===key.key)
}
export async function documentRequestValues(actor:DealActor,key:DocumentConditionKey,clock=nowIso()){
 const condition=await activeDocumentCondition(actor,key,clock)
 if(!condition)throw new AppError(409,'notification_condition_resolved','This document condition is resolved. Refresh the document list.')
 if(!key.linkId)throw new AppError(409,'document_request_link_invalid','Choose a live scoped document request link.')
 const row=await getDatabase().prepare<{id:string;deal_id:string;stipulation_id:string;destination_category:string;token_cipher:string|null;expires_at:string;revoked_at:string|null;used_count:number;max_uploads:number;status:string}>(`SELECT l.*,s.status FROM mca_merchant_upload_links l JOIN mca_closing_stipulations s ON s.workspace_id=l.workspace_id AND s.id=l.stipulation_id AND s.deal_id=l.deal_id WHERE l.workspace_id=? AND l.deal_id=? AND l.id=?`).get(actor.workspaceId,key.dealId,key.linkId)
 if(!row||!row.token_cipher||row.revoked_at||row.expires_at<=clock||row.used_count>=row.max_uploads||!['open','received'].includes(row.status)||row.destination_category!==condition.category||(condition.stipulationId&&row.stipulation_id!==condition.stipulationId))throw new AppError(409,'document_request_link_invalid','This request link is unavailable, expired, consumed or revoked.')
 const token=decryptSensitive(row.token_cipher,actor.workspaceId)
 try{
  const binding=await merchantUploadBinding(token)
  if(binding.workspaceId!==actor.workspaceId||binding.dealId!==key.dealId||binding.linkId!==row.id)throw new Error('binding')
 }catch{throw new AppError(409,'document_request_link_invalid','This document request link is unavailable.')}
 const origin=process.env.MCA_APP_ORIGIN??'http://localhost:3000'
 const url=new URL(`/merchant-upload/${encodeURIComponent(token)}`,origin)
 if(url.protocol!=='https:'&&!(process.env.NODE_ENV!=='production'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new AppError(503,'document_request_origin_invalid','Configure a secure application origin.')
 return{document_request_url:url.toString(),document_request_label:condition.label}
}
export async function documentConditionSnapshot(actor:DealActor,dealId:string,clock=nowIso()){
 const facts=await documentNotificationFacts(actor,dealId,clock)
 const links=await getDatabase().prepare<{id:string;stipulationId:string;category:string;expiresAt:string;label:string}>(`SELECT l.id,l.stipulation_id AS "stipulationId",l.destination_category category,l.expires_at AS "expiresAt",s.label FROM mca_merchant_upload_links l JOIN mca_closing_stipulations s ON s.workspace_id=l.workspace_id AND s.id=l.stipulation_id AND s.deal_id=l.deal_id WHERE l.workspace_id=? AND l.deal_id=? AND l.revoked_at IS NULL AND l.expires_at>? AND l.used_count<l.max_uploads AND l.token_cipher IS NOT NULL AND s.status IN ('open','received') ORDER BY l.created_at DESC`).all(actor.workspaceId,dealId,clock)
 return{dealId,asOf:clock,requiredStatementPeriod:previousCompletedUtcMonth(clock),conditions:deriveDocumentConditions(facts),links}
}
