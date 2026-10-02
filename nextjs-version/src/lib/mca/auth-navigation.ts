/** Only app-relative dashboard destinations survive authentication. */
export function safeAuthReturnTo(value: string | null): string {
  if (
    !value ||
    !/^\/(dashboard|deals|offers|advances|renewals|sms|reports|payments|settings)(?:[/?#]|$)/.test(
      value
    ) ||
    /[\\\r\n]/.test(value)
  )
    return "/dashboard"
  return value
}

export function authErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message
  return "We couldn't complete that request. Please try again."
}

/** Explicit auth destinations only; never accept a host, encoded path, or arbitrary query. */
export function authContinuation(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/onboarding"
  const url = new URL(value, "https://auth.invalid")
  if (url.origin !== "https://auth.invalid" || !value.startsWith("/")) return "/onboarding"
  if (url.pathname === "/accept-invite") {
    const token = url.searchParams.get("token")
    if (token && /^[A-Za-z0-9_-]{16,256}$/.test(token)) return `/accept-invite?token=${encodeURIComponent(token)}`
  }
  if (url.pathname === "/account-security") return "/account-security"
  if (url.pathname === "/activate") return "/activate"
  if (url.pathname === "/onboarding") {
    const target = safeAuthReturnTo(url.searchParams.get("returnTo"))
    return `/onboarding?returnTo=${encodeURIComponent(target)}`
  }
  return "/onboarding"
}

export function currentAuthContinuation(): string {
  const url = new URL(window.location.href)
  return authContinuation(url.pathname === "/accept-invite" ? url.pathname + url.search : url.searchParams.get("next") ?? `/onboarding?returnTo=${encodeURIComponent(safeAuthReturnTo(url.searchParams.get("returnTo")))}`)
}

/** Recovery is a separate step; its next parameter is always a sanitized final destination. */
export function recoveryDestination(value: string | null): string {
  return `/reset-password?next=${encodeURIComponent(authContinuation(value))}`
}

export function callbackDestination(value: string | null, recovery: boolean): string {
  if (value?.startsWith("/reset-password") && !/[\\\r\n]/.test(value)) {
    const url = new URL(value, "https://auth.invalid")
    if (url.pathname === "/reset-password") return recoveryDestination(url.searchParams.get("next"))
  }
  return recovery ? recoveryDestination(value) : authContinuation(value)
}

/** Email templates encode RedirectTo as one parameter rather than concatenating query strings. */
export function emailCallbackContinuation(value: string | null, origin: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.origin !== origin || url.pathname !== "/auth/callback" || url.username || url.password || url.hash) return null
    return url.searchParams.get("next")
  } catch { return null }
}
