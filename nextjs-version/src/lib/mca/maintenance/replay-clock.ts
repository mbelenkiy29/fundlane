import "server-only"
import { AsyncLocalStorage } from "node:async_hooks"

const replayReceiptTime = new AsyncLocalStorage<number>()
/** A replay verifies the original signature against trusted, encrypted receipt time. */
export const webhookVerificationTime = () => replayReceiptTime.getStore() ?? Date.now()
/** CLI-only context. Never accept a replay timestamp or bypass token from HTTP headers. */
export function withWebhookReplayClock<T>(receivedAt: string, operation: () => Promise<T>): Promise<T> {
  const time = Date.parse(receivedAt)
  if (!Number.isFinite(time) || time > Date.now() + 30_000) throw new Error("Invalid captured webhook receipt time.")
  return replayReceiptTime.run(time, operation)
}
