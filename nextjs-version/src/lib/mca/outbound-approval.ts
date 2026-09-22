import "server-only"
import { AsyncLocalStorage } from "node:async_hooks"
import { assertCompanyOutboundAllowed } from "./company-access"

const approval = new AsyncLocalStorage<{ workspaceId: string; approvedAt: string }>()

/** Conversion into a new delivery/SMS row must not renew the original approval. */
export async function assertOutboundDispatch(workspaceId: string, approvedAt: string): Promise<void> {
  const parent = approval.getStore()
  if (parent?.workspaceId === workspaceId) await assertCompanyOutboundAllowed(workspaceId, parent.approvedAt)
  await assertCompanyOutboundAllowed(workspaceId, approvedAt)
}

export async function withOutboundApproval<T>(workspaceId: string, approvedAt: string, action: () => Promise<T>): Promise<T> {
  await assertOutboundDispatch(workspaceId, approvedAt)
  const parent = approval.getStore()
  const original = parent?.workspaceId === workspaceId && Date.parse(parent.approvedAt) < Date.parse(approvedAt) ? parent.approvedAt : approvedAt
  return approval.run({ workspaceId, approvedAt: original }, action)
}
