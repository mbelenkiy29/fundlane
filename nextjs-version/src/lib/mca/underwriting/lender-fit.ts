import "server-only"
import { nowIso, withTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { listFunderCriteria } from "../funders/criteria"
import { listFunders } from "../funders/directory"
import { getDealScores } from "./scoring"
import { projectLenderFit } from "./lender-fit-projection"
import type { LenderFitResponse } from "./lender-fit-contracts"

/** Authorized read only. Never scores, selects lenders or infers offer terms. */
export async function getLenderFit(actor: DealActor, dealId: string): Promise<LenderFitResponse> {
  return withTransaction(async (database) => {
    await database.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    const current = await getDealScores(actor, dealId)
    const funders = await listFunders(actor, { includeInactive: true })
    const criteria = Object.fromEntries(await Promise.all(funders.map(async (funder) => [funder.id, (await listFunderCriteria(actor, funder.id)).rules] as const)))
    return projectLenderFit({
      asOf: nowIso(), funders, criteria, scores: current.snapshot?.scores ?? [],
      snapshotId: current.snapshot?.id ?? null, scoredAt: current.snapshot?.createdAt ?? null,
      stale: current.stale, staleReasons: current.staleReasons,
      policyVersion: current.snapshot?.policyVersion ?? 0, underwritingVersion: current.snapshot?.underwritingVersion ?? 0,
    })
  })
}
