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
