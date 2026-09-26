export function marketingPolishEnabled(): boolean {
  return process.env.MCA_MARKETING_POLISH_ENABLED === 'true'
}

export function companyLegalName(): string | null {
  const value = process.env.NEXT_PUBLIC_MCA_COMPANY_LEGAL_NAME?.trim()
  return value || null
}
