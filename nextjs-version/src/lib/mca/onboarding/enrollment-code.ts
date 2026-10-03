/** Codes are often pasted with spaces or dashes; strip separators only, never letters. */
export function normalizeEnrollmentCode(raw: string): string {
  return raw.replace(/[\s\-‐-―−.]/g, "")
}
export const enrollmentCodePattern = /^\d{6,10}$/
export function enrollmentCodeError(raw: string): string | null {
  return enrollmentCodePattern.test(normalizeEnrollmentCode(raw))
    ? null
    : "Enter the 6–10 digit code from your email."
}
