import "server-only"

import { getDatabase, parseJson, withImmediateTransaction } from "../db"
import type { CriteriaOperator, CriteriaUnit, EligibilityRule, IndustryAlias } from "./contracts"

type CriteriaRow = {
  id: string
  workspace_id: string
  funder_id: string
  field: string
  operator: string
  unit: string
  value_json: string | null
  source_text: string | null
  unspecified: number
  position: number
  created_at: string
  updated_at: string
}

type AliasRow = {
  id: string
  workspace_id: string
  alias: string
  naics: string | null
  normalized_industry: string
  created_at: string
  updated_at: string
}

type MetaRow = {
  workspace_id: string
  funder_id: string
  fingerprint: string
  published_at: string
}

function db() { return getDatabase() }

function fromCriteriaRow(row: CriteriaRow): EligibilityRule {
  const unspecified = Boolean(row.unspecified)
  return {
    id: row.id,
    funderId: row.funder_id,
    field: row.field,
    operator: row.operator as CriteriaOperator,
    unit: row.unit as CriteriaUnit,
    value: unspecified ? null : parseJson<EligibilityRule["value"]>(row.value_json, null),
    sourceText: row.source_text ?? undefined,
    unspecified,
  }
}

function fromAliasRow(row: AliasRow): IndustryAlias {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    alias: row.alias,
    naics: row.naics ?? undefined,
    normalizedIndustry: row.normalized_industry,
  }
}

export interface StoredCriteriaSet {
  funderId: string
  fingerprint: string | null
  publishedAt: string | null
  rules: EligibilityRule[]
}

export async function listCriteriaRules(workspaceId: string, funderId: string): Promise<StoredCriteriaSet> {
  const database = db()
  const meta = await database.prepare<MetaRow>("SELECT * FROM mca_funder_criteria_meta WHERE workspace_id = ? AND funder_id = ?")
    .get(workspaceId, funderId)
  const rows = await database.prepare<CriteriaRow>("SELECT * FROM mca_funder_criteria WHERE workspace_id = ? AND funder_id = ? ORDER BY position, created_at")
    .all(workspaceId, funderId)
  return {
    funderId,
    fingerprint: meta?.fingerprint ?? null,
    publishedAt: meta?.published_at ?? null,
    rules: rows.map(fromCriteriaRow),
  }
}

export async function replaceCriteriaRules(input: {
  workspaceId: string
  funderId: string
  rules: EligibilityRule[]
  fingerprint: string
  publishedAt: string
  criteriaVersion: number
  bumpVersion: boolean
}): Promise<void> {
  await withImmediateTransaction(async (database) => {
    await database.prepare("DELETE FROM mca_funder_criteria WHERE workspace_id = ? AND funder_id = ?").run(input.workspaceId, input.funderId)
    const insert = database.prepare(`INSERT INTO mca_funder_criteria
      (id, workspace_id, funder_id, field, operator, unit, value_json, source_text, unspecified, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const [index, rule] of input.rules.entries()) {
      await insert.run(
        rule.id,
        input.workspaceId,
        input.funderId,
        rule.field,
        rule.operator,
        rule.unit,
        rule.unspecified ? null : JSON.stringify(rule.value),
        rule.sourceText ?? null,
        rule.unspecified ? 1 : 0,
        index,
        input.publishedAt,
        input.publishedAt,
      )
    }
    await database.prepare(`INSERT INTO mca_funder_criteria_meta (workspace_id, funder_id, fingerprint, published_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, funder_id) DO UPDATE SET fingerprint = excluded.fingerprint, published_at = excluded.published_at`)
      .run(input.workspaceId, input.funderId, input.fingerprint, input.publishedAt)
    if (input.bumpVersion) {
      await database.prepare("UPDATE mca_funders SET criteria_version = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(input.criteriaVersion, input.publishedAt, input.workspaceId, input.funderId)
    }
  })
}

export async function listAliasRecords(workspaceId: string): Promise<IndustryAlias[]> {
  const rows = await db().prepare<AliasRow>("SELECT * FROM mca_industry_aliases WHERE workspace_id = ? ORDER BY lower(alias), created_at")
    .all(workspaceId)
  return rows.map(fromAliasRow)
}

export async function findAliasById(workspaceId: string, id: string): Promise<IndustryAlias | undefined> {
  const row = await db().prepare<AliasRow>("SELECT * FROM mca_industry_aliases WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  return row ? fromAliasRow(row) : undefined
}

export async function findAliasByName(workspaceId: string, alias: string): Promise<IndustryAlias | undefined> {
  const row = await db().prepare<AliasRow>("SELECT * FROM mca_industry_aliases WHERE workspace_id = ? AND lower(alias) = lower(?)").get(workspaceId, alias)
  return row ? fromAliasRow(row) : undefined
}

export async function findAliasByNaics(workspaceId: string, naics: string): Promise<IndustryAlias | undefined> {
  const row = await db().prepare<AliasRow>("SELECT * FROM mca_industry_aliases WHERE workspace_id = ? AND lower(naics) = lower(?)").get(workspaceId, naics)
  return row ? fromAliasRow(row) : undefined
}

export async function insertAliasRecord(record: IndustryAlias & { createdAt: string; updatedAt: string }): Promise<IndustryAlias> {
  await db().prepare(`INSERT INTO mca_industry_aliases (id, workspace_id, alias, naics, normalized_industry, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(record.id, record.workspaceId, record.alias, record.naics ?? null, record.normalizedIndustry, record.createdAt, record.updatedAt)
  const saved = await findAliasById(record.workspaceId, record.id)
  if (!saved) throw new Error("Industry alias not found after insert")
  return saved
}

export async function updateAliasRecord(record: IndustryAlias & { updatedAt: string }): Promise<IndustryAlias> {
  await db().prepare("UPDATE mca_industry_aliases SET alias = ?, naics = ?, normalized_industry = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(record.alias, record.naics ?? null, record.normalizedIndustry, record.updatedAt, record.workspaceId, record.id)
  const saved = await findAliasById(record.workspaceId, record.id)
  if (!saved) throw new Error("Industry alias not found after update")
  return saved
}

export async function deleteAliasRecord(workspaceId: string, id: string): Promise<boolean> {
  const result = await db().prepare("DELETE FROM mca_industry_aliases WHERE workspace_id = ? AND id = ?").run(workspaceId, id)
  return result.changes > 0
}
