export function normalizeEin(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  const digits = value.replace(/\D/g, "")
  return digits.length === 9 ? digits : undefined
}

export function formatEin(value: string | undefined | null): string | undefined {
  const digits = normalizeEin(value)
  return digits ? `${digits.slice(0, 2)}-${digits.slice(2)}` : undefined
}

export function normalizeIdentityLast4(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  const digits = value.replace(/\D/g, "")
  return digits.length === 4 ? digits : undefined
}
