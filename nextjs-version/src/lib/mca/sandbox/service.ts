import "server-only"

import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent } from "../db"
import type { DealActor } from "../deals/schema"
import { canManageWorkspace } from "../policy"
import type { FunderRecord } from "../funders/contracts"
import {
  findFunderByIdempotencyKey,
  insertFunder,
  toFunderRecord,
  updateFunderRecord,
  type StoredFunder,
} from "../funders/directory-repository"
import { listSampleStatementsForWorkspace, type SampleStatement } from "./statements"
import {
  SANDBOX_DOMAIN,
  SANDBOX_FUNDER_IDEMPOTENCY_KEY,
  SANDBOX_LEGAL_NAME,
  SANDBOX_NICKNAME,
  SANDBOX_PRODUCT,
  SANDBOX_ROUTE_DESTINATION,
  SANDBOX_WARNING,
} from "./labels"

export interface SandboxFunderStatus {
  enabled: boolean
  warning: string
  funder: FunderRecord | null
  statements: SampleStatement[]
}

function assertManage(actor: DealActor): void {
  if (!actor.role || !canManageWorkspace(actor.role)) {
    throw new AppError(403, "permission_denied", "You do not have permission to perform this action.")
  }
}

function sandboxProfile(current?: StoredFunder): Omit<StoredFunder, "id" | "workspaceId" | "idempotencyKey" | "createdAt" | "updatedAt" | "criteriaVersion" | "profileVersion"> {
  return {
    legalName: SANDBOX_LEGAL_NAME,
    nickname: SANDBOX_NICKNAME,
    website: undefined,
    domains: [SANDBOX_DOMAIN],
    products: [SANDBOX_PRODUCT],
    active: true,
    contacts: [],
    routes: [{
      id: current?.routes.find((route) => route.destination === SANDBOX_ROUTE_DESTINATION)?.id ?? newId(),
      kind: "api",
      label: "[SANDBOX] Local synthetic reply — no outbound contact",
      destination: SANDBOX_ROUTE_DESTINATION,
      documentExceptions: [],
      active: true,
    }],
  }
}

export async function getSandboxFunderStatus(actor: DealActor): Promise<SandboxFunderStatus> {
  const record = await findFunderByIdempotencyKey(actor.workspaceId, SANDBOX_FUNDER_IDEMPOTENCY_KEY)
  return {
    enabled: Boolean(record?.active),
    warning: SANDBOX_WARNING,
    funder: record ? toFunderRecord(record) : null,
    statements: await listSampleStatementsForWorkspace(actor.workspaceId),
  }
}

export async function setSandboxFunderEnabled(actor: DealActor, enabled: boolean): Promise<SandboxFunderStatus> {
  assertManage(actor)
  const now = nowIso()
  const existing = await findFunderByIdempotencyKey(actor.workspaceId, SANDBOX_FUNDER_IDEMPOTENCY_KEY)
  if (!enabled) {
    if (existing?.active) {
      await updateFunderRecord({
        ...existing,
        ...sandboxProfile(existing),
        active: false,
        profileVersion: existing.profileVersion + 1,
        updatedAt: now,
      })
      await recordAuditEvent({
        context: actor,
        action: "sandbox_funder.disabled",
        resourceType: "funder",
        resourceId: existing.id,
        metadata: { sandbox: true },
        correlationId: actor.correlationId,
      })
    }
    return getSandboxFunderStatus(actor)
  }

  if (existing) {
    if (!existing.active || existing.legalName !== SANDBOX_LEGAL_NAME) {
      await updateFunderRecord({
        ...existing,
        ...sandboxProfile(existing),
        active: true,
        profileVersion: existing.profileVersion + 1,
        updatedAt: now,
      })
      await recordAuditEvent({
        context: actor,
        action: existing.active ? "sandbox_funder.relabeled" : "sandbox_funder.enabled",
        resourceType: "funder",
        resourceId: existing.id,
        metadata: { sandbox: true, created: false },
        correlationId: actor.correlationId,
      })
    }
    return getSandboxFunderStatus(actor)
  }

  const saved = await insertFunder({
    id: newId(),
    workspaceId: actor.workspaceId,
    idempotencyKey: SANDBOX_FUNDER_IDEMPOTENCY_KEY,
    ...sandboxProfile(),
    criteriaVersion: 1,
    profileVersion: 1,
    createdAt: now,
    updatedAt: now,
  })
  await recordAuditEvent({
    context: actor,
    action: "sandbox_funder.enabled",
    resourceType: "funder",
    resourceId: saved.record.id,
    metadata: { sandbox: true, created: saved.inserted },
    correlationId: actor.correlationId,
  })
  return getSandboxFunderStatus(actor)
}
