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

export type EnrollmentDestination = "crm" | "business" | "billing"
export type CanonicalEnrollmentContinuation = `/enrollment?${string}`
export type EnrollmentContinuation = {
  enrollmentId: string
  destination?: EnrollmentDestination
  generation?: number
}

/** An opaque locator is navigation context, never an authorization capability. */
export function parseEnrollmentContinuation(
  value: string | null
): EnrollmentContinuation | null {
  if (!value || !value.startsWith("/enrollment?") || /[\\\r\n#]/.test(value))
    return null
  const url = new URL(value, "https://auth.invalid")
  if (url.pathname !== "/enrollment") return null
  for (const key of ["enrollment", "destination", "generation"])
    if (url.searchParams.getAll(key).length > 1) return null
  const enrollmentId = url.searchParams.get("enrollment")
  const destination = url.searchParams.get("destination")
  const generation = url.searchParams.get("generation")
  if (
    !enrollmentId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      enrollmentId
    )
  )
    return null
  if (
    destination !== null &&
    !["crm", "business", "billing"].includes(destination)
  )
    return null
  if (
    generation !== null &&
    (!/^[1-9]\d*$/.test(generation) ||
      !Number.isSafeInteger(Number(generation)))
  )
    return null
  return {
    enrollmentId,
    ...(destination
      ? { destination: destination as EnrollmentDestination }
      : {}),
    ...(generation ? { generation: Number(generation) } : {}),
  }
}

export function enrollmentContinuation(
  input: EnrollmentContinuation
): CanonicalEnrollmentContinuation {
  const query = new URLSearchParams({ enrollment: input.enrollmentId })
  if (input.destination) query.set("destination", input.destination)
  if (input.generation !== undefined)
    query.set("generation", String(input.generation))
  return `/enrollment?${query}`
}

/** Explicit auth destinations only; never accept a host, encoded path, or arbitrary query. */
export function authContinuation(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value)
  )
    return "/onboarding"
  const url = new URL(value, "https://auth.invalid")
  if (url.origin !== "https://auth.invalid" || !value.startsWith("/"))
    return "/onboarding"
  const enrollment = parseEnrollmentContinuation(value)
  if (enrollment) return enrollmentContinuation(enrollment)
  if (url.pathname === "/accept-invite") {
    const token = url.searchParams.get("token")
    if (token && /^[A-Za-z0-9_-]{16,256}$/.test(token))
      return `/accept-invite?token=${encodeURIComponent(token)}`
  }
  if (url.pathname === "/account-security") {
    if (
      url.searchParams.getAll("next").length > 1 ||
      url.searchParams.getAll("challenge").length > 1 ||
      url.searchParams.getAll("required").length > 1
    )
      return "/onboarding"
    const rawNext = url.searchParams.get("next")
    if (rawNext) {
      try {
        if (
          new URL(rawNext, "https://auth.invalid").pathname ===
          "/account-security"
        )
          return "/onboarding"
      } catch {
        return "/onboarding"
      }
    }
    const query = new URLSearchParams()
    if (url.searchParams.get("challenge") === "1") query.set("challenge", "1")
    else if (url.searchParams.get("required") === "1")
      query.set("required", "1")
    if (rawNext) query.set("next", authContinuation(rawNext))
    return `/account-security${query.size ? `?${query}` : ""}`
  }
  if (url.pathname === "/onboarding") {
    const target = safeAuthReturnTo(url.searchParams.get("returnTo"))
    return `/onboarding?returnTo=${encodeURIComponent(target)}`
  }
  return "/onboarding"
}

export function currentAuthContinuation(): string {
  const url = new URL(window.location.href)
  return authContinuation(
    ["/accept-invite", "/enrollment"].includes(url.pathname)
      ? url.pathname + url.search
      : (url.searchParams.get("next") ??
          `/onboarding?returnTo=${encodeURIComponent(safeAuthReturnTo(url.searchParams.get("returnTo")))}`)
  )
}

/** Recovery is a separate step; its next parameter is always a sanitized final destination. */
export function recoveryDestination(value: string | null): string {
  return `/reset-password?next=${encodeURIComponent(authContinuation(value))}`
}

export function callbackDestination(
  value: string | null,
  recovery: boolean
): string {
  if (value?.startsWith("/reset-password") && !/[\\\r\n]/.test(value)) {
    const url = new URL(value, "https://auth.invalid")
    if (url.pathname === "/reset-password")
      return recoveryDestination(url.searchParams.get("next"))
  }
  return recovery ? recoveryDestination(value) : authContinuation(value)
}

/** Email templates encode RedirectTo as one parameter rather than concatenating query strings. */
export function emailCallbackContinuation(
  value: string | null,
  origin: string
): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (
      url.origin !== origin ||
      url.pathname !== "/auth/callback" ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll("next").length > 1 ||
      url.searchParams.getAll("challenge").length > 1
    )
      return null
    return url.searchParams.get("next")
  } catch {
    return null
  }
}

export function emailCallbackChallenge(
  value: string | null,
  origin: string
): string | null {
  if (emailCallbackContinuation(value, origin) === null) return null
  return new URL(value!).searchParams.get("challenge")
}
