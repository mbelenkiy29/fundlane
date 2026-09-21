import "server-only"

import { getDeal } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { listDocuments } from "../documents/service"
import { AppError } from "../errors"
import { getDealReview } from "../underwriting/review-mail"
import { getUnderwritingAggregate, listExistingPositions } from "../underwriting/statements"
import { getCompleteness } from "../underwriting/completeness"
import { requireSubmissionActor } from "../submissions/queue"
import { getWorkspaceSettings } from "../workspaces"
import { effectivePageVisibility } from "../policy"
import { listJobsForDeal } from "../submissions/repository"
import { findIntake, getIntegration } from "./repository"
import { intakeProgress } from "./processing"
import type { ApplicationReview } from "./review-contracts"

const identityField = /(?:^|[^a-z])(?:ein|ssn|tin|dob)(?:$|[^a-z])|identity|social.?security|tax.?id|date.?of.?birth|birth.?date|passport|driver.?licen[cs]e.?number/i
function sensitiveField(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return identityField.test(normalized) || /owner.*(?:email|phone)/i.test(normalized)
}
export function protectIntakeAnswers(answers: ApplicationReview['answers'], mapping: Record<string,string> = {}, submittedApplication: unknown = {}): ApplicationReview['answers'] {
  const protectedPaths = Object.entries(mapping).filter(([target])=>sensitiveField(target)).map(([,path])=>path)
  // The submitted canonical fields also protect opaque answers after mappings change.
  const sensitiveValues = new Set<string>()
  function collect(value: unknown, path = "") {
    if(value && typeof value === 'object') {
      for(const [key,item] of Object.entries(value)) collect(item, `${path}.${key}`)
    } else if(value !== null && value !== undefined && sensitiveField(path) && String(value)) sensitiveValues.add(String(value))
  }
  collect(submittedApplication)
  const isProtected = (key: string) => sensitiveField(key) || protectedPaths.some(path=>key===path || key.startsWith(`${path}.`))
  function protectValue(key: string,value: unknown): unknown {
    if(isProtected(key) || (value !== null && typeof value !== 'object' && sensitiveValues.has(String(value)))) return "••••"
    if(Array.isArray(value)) return value.map((item,index)=>protectValue(`${key}.${index}`,item))
    if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,protectValue(`${key}.${name}`,item)]))
    return value
  }
  return answers.map(answer=>{
    if(isProtected(answer.key) || isProtected(answer.label) || sensitiveValues.has(answer.value)) return {...answer,value:"••••"}
    try { return {...answer,value:JSON.stringify(protectValue(answer.key,JSON.parse(answer.value)))} }
    catch { return answer }
  })
}

export async function getApplicationReview(actor: DealActor,intakeId: string): Promise<ApplicationReview> {
  const intake=await findIntake(actor.workspaceId,intakeId)
  if(!intake) throw new AppError(404,"intake_not_found","The application was not found.")
  const deal=intake.dealId ? await getDeal(actor,intake.dealId) : null
  if(!deal && !['admin','super_admin'].includes(actor.role ?? '')) throw new AppError(404,"intake_not_found","The application was not found.")
  const progress=await intakeProgress(actor.workspaceId,intakeId)
  const integration=intake.integrationId ? await getIntegration(actor.workspaceId,intake.integrationId):undefined
  const [documents,review,aggregate,completeness,positions,jobs]=deal ? await Promise.all([
    listDocuments(actor,deal.id),getDealReview(actor,deal.id),getUnderwritingAggregate(actor,deal.id),getCompleteness(actor,deal.id),listExistingPositions(actor,deal.id),listJobsForDeal(actor.workspaceId,deal.id)
  ]):[[],null,null,null,[],[]] as const
  const legacyAnswers=Object.entries(intake.application).filter(([key,value])=>value!==undefined && !['assignments','fieldSource','idempotencyKey'].includes(key)).map(([key,value])=>({key,label:key.replace(/([a-z])([A-Z])/g,'$1 $2'),value:typeof value==='string'?value:JSON.stringify(value)}))
  const canWrite=actor.source!=='api_key' || Boolean(actor.scopes?.includes('deals:write'))
  const proposed=positions.filter(position=>position.status==='proposed')
  const missing=[...(completeness?.findings.map(f=>f.message)??[]),...(proposed.length?["Confirm or dismiss existing funding positions in the deal before sending."]:[])]
  return {
    intakeId,dealId:deal?.id??null,merchantName:deal?.legalName || 'Application needs review',receivedAt:intake.createdAt,provider:intake.provider,
    originalAnswersAvailable:intake.answers!==undefined,answers:protectIntakeAnswers(intake.answers??legacyAnswers,integration?.mapping,intake.application),documents:[...documents],progress:progress??null,
    message:progress?.message ?? intake.errorMessage ?? (!integration?.automaticProcessing?'Automatic processing is paused for this connection.':undefined),
    summary:{reportedMonthlyRevenue:intake.application.monthlyRevenue??null,statementMonthlyRevenue:aggregate?.monthlyRevenue.unknown?null:aggregate?.monthlyRevenue.value??null,industry:deal?.industry??null,requestedAmount:deal?.requestedAmount??null,warnings:aggregate?.warnings??[],missing,stale:Boolean(review?.stale||aggregate?.stale),analyzedAt:aggregate?.computedAt??null},
    candidates:(review?.candidates??[]).map((candidate,index)=>({id:candidate.funderId,name:candidate.name,rank:index+1,score:candidate.score,grade:candidate.grade,eligible:candidate.eligible&&!candidate.blocked,reasons:candidate.reasons.map(reason=>reason.detail)})),
    canPrepare:Boolean(canWrite && review?.run && review.completenessReady && !review.stale && !aggregate?.stale && !proposed.length && progress?.state==='ready_for_review'),
    canRetry:Boolean(canWrite && deal && integration?.enabled && integration.automaticProcessing),
    jobs:jobs.map(job=>({jobId:job.id,displayFunderName:job.displayFunderName,state:job.state,reason:job.reason})),
  }
}

export async function requireApplicationActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  const actor=await requireSubmissionActor(request,mode)
  if(actor.role) {
    const settings=await getWorkspaceSettings(actor.workspaceId)
    if(!effectivePageVisibility(actor.role,settings.pageVisibility,settings.featureFlags).deals) {
      throw new AppError(403,"page_hidden","Applications are unavailable for this account.")
    }
  }
  return actor
}
