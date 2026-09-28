/** Draft legal pages are opt-in until their content has legal approval. */
export function legalDraftPagesEnabled(): boolean {
  return process.env.MCA_LEGAL_DRAFT_PAGES_ENABLED === "true"
}
