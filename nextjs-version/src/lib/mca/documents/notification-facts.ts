export interface DocumentCondition {
  key: string
  reason: 'missing' | 'requested' | 'stale'
  category: string
  label: string
  requiredPeriod?: string
  stipulationId?: string
}
export interface DocumentNotificationFacts {
  dealId: string
  status: string
  clock: string
  documents: Array<{ id: string; category: string; processingState: string; version: number; lineageId: string; createdAt: string }>
  periods: Array<{ documentId: string; period: string; duplicateOfId?: string }>
  stipulations: Array<{ id: string; category: string; label: string; status: string; linkedDocumentId?: string }>
}
/** Calendar month is UTC, never elapsed days or the document upload date. */
export function previousCompletedUtcMonth(clock: string): string {
  const date = new Date(clock)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid document notification clock.')
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() - 1)
  return date.toISOString().slice(0, 7)
}
const buckets = [
  { category: 'application', label: 'Funding application', categories: ['application', 'api_application'] },
  { category: 'statement', label: 'Bank statement', categories: ['statement'] },
  { category: 'driver_license', label: 'Driver license', categories: ['driver_license'] },
  { category: 'voided_check', label: 'Voided check', categories: ['voided_check'] },
]
export function deriveDocumentConditions(facts: DocumentNotificationFacts): DocumentCondition[] {
  const period = previousCompletedUtcMonth(facts.clock)
  if (['closed', 'funded'].includes(facts.status)) return []
  const latest = new Map<string, DocumentNotificationFacts['documents'][number]>()
  for (const document of facts.documents) {
    const prior = latest.get(document.lineageId)
    if (!prior || document.version > prior.version || (document.version === prior.version && document.createdAt > prior.createdAt)) latest.set(document.lineageId, document)
  }
  const clean = [...latest.values()].filter(document => document.processingState === 'clean')
  const conditions: DocumentCondition[] = []
  for (const bucket of buckets) {
    const documents = clean.filter(document => bucket.categories.includes(document.category))
    const currentPeriod = bucket.category === 'statement' ? period : undefined
    const reason = !documents.length ? 'missing' : bucket.category === 'statement' && !facts.periods.some(month => !month.duplicateOfId && month.period === period && documents.some(document => document.id === month.documentId)) ? 'stale' : undefined
    if (reason) conditions.push({ key: `${reason}:${bucket.category}:${currentPeriod ?? 'required'}`, reason, category: bucket.category, label: bucket.label, ...(currentPeriod ? { requiredPeriod: currentPeriod } : {}) })
  }
  for (const stipulation of facts.stipulations) {
    if (!['open', 'received'].includes(stipulation.status)) continue
    if (stipulation.linkedDocumentId && clean.some(document => document.id === stipulation.linkedDocumentId)) continue
    conditions.push({ key: `requested:${stipulation.id}`, reason: 'requested', category: stipulation.category, label: stipulation.label, stipulationId: stipulation.id })
  }
  return conditions
}
