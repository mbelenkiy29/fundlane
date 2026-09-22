/** Exact recovery surfaces; never exempt a business route by a caller-supplied prefix. */
export function isCompanyRecoveryApi(pathname: string): boolean {
  return ["/api/billing", "/api/billing/checkout", "/api/billing/portal", "/api/billing/sync", "/api/billing/cancel"].includes(pathname)
}

export function isCompanyRecoveryPage(pathname: string): boolean {
  return pathname === "/settings/billing"
}
