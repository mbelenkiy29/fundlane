import type { ApiErrorBody } from "./types"

export class RequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "request_failed",
    public readonly fieldErrors?: Record<string, string[]>,
    public readonly matches?: unknown,
  ) {
    super(message)
  }
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const body = payload as ApiErrorBody
    const error = body.error
    throw new RequestError(
      response.status,
      error?.message ?? "The request could not be completed.",
      error?.code,
      error?.fieldErrors,
      body.matches ?? error?.matches,
    )
  }
  return (payload.data ?? payload) as T
}

export function formatRole(role: string) {
  return role === "super_admin" ? "Super admin" : role.charAt(0).toUpperCase() + role.slice(1)
}
