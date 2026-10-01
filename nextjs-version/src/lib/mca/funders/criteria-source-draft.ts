export interface CriteriaSourceDraft { sourceText: string; sourceAsOf: string; validUntil: string }
type SourceFacts = { sourceText?: string; sourceAsOf?: string; validUntil?: string }
/** Shared by manual and scan editors so reviewing a scan never erases source dates. */
export function sourceDraft(rule: SourceFacts): CriteriaSourceDraft {
  return { sourceText: rule.sourceText ?? "", sourceAsOf: rule.sourceAsOf ?? "", validUntil: rule.validUntil ?? "" }
}
export function sourcePayload(draft: CriteriaSourceDraft): SourceFacts {
  return { sourceText: draft.sourceText.trim() || undefined, sourceAsOf: draft.sourceAsOf || undefined, validUntil: draft.validUntil || undefined }
}
