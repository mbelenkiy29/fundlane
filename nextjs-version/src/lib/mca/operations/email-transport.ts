/** Shared transactional webhook transport. No framework imports: used by Next.js and the scheduled monitor. */
export function sendTransactionalWebhook(
  url: string,
  token: string | undefined,
  message: unknown,
  correlationId: string,
  fetcher: typeof fetch = fetch,
  timeout = 10000
) {
  return fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": correlationId,
      "idempotency-key": correlationId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  })
}
