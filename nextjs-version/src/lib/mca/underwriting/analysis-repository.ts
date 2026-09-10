import "server-only"

import { getDatabase, parseJson } from "../db"
import type { AnalysisMode, AnalysisRun } from "./contracts"

export const DEFAULT_ANALYSIS_TOP_N = 5
export const REVIEW_NOTIFICATION_CHANNELS = ["select_only", "email_only", "both"] as const
export type ReviewNotificationChannel = (typeof REVIEW_NOTIFICATION_CHANNELS)[number]

export interface AnalysisSettings {
  mode: AnalysisMode
  topN: number
  reviewNotificationChannel: ReviewNotificationChannel
  automaticSendEnabled: boolean
}

export interface AnalysisDestination {
  funderId: string
  outcome: "selected" | "excluded" | "blocked"
  reason: string
}

export interface StoredAnalysisRun extends AnalysisRun {
  workspaceId: string
  dealId: string
  completenessVersion: number
  trigger: "manual" | "readiness"
  topN: number
  reviewNotificationChannel: ReviewNotificationChannel
  destinations: AnalysisDestination[]
  settingsSnapshot: AnalysisSettings
  queued: boolean
  createdAt: string
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  mode: "review_first",
  topN: DEFAULT_ANALYSIS_TOP_N,
  reviewNotificationChannel: "both",
  automaticSendEnabled: false,
}

type SettingsRow = {
  workspace_id: string
  mode: string
  top_n: number
  review_notification_channel: string
  automatic_send_enabled: number | boolean
  updated_at: string
  updated_by_user_id: string | null
}

type RunRow = {
  id: string
  workspace_id: string
  deal_id: string
  snapshot_id: string
  completeness_version: number
  trigger: string
  mode: string
  state: string
  top_n: number
  review_notification_channel: string
  selected_funder_ids: string
  destinations_json: string
  settings_snapshot: string
  reason: string
  queued: number | boolean
  created_at: string
}

function asChannel(value: string | null | undefined): ReviewNotificationChannel {
  return REVIEW_NOTIFICATION_CHANNELS.includes(value as ReviewNotificationChannel)
    ? value as ReviewNotificationChannel
    : DEFAULT_ANALYSIS_SETTINGS.reviewNotificationChannel
}

function asMode(value: string | null | undefined): AnalysisMode {
  if (value === "analyze_only" || value === "review_first" || value === "automatic_send") return value
  return DEFAULT_ANALYSIS_SETTINGS.mode
}

function mapSettings(row: SettingsRow | undefined): AnalysisSettings {
  if (!row) return { ...DEFAULT_ANALYSIS_SETTINGS }
  return {
    mode: asMode(row.mode),
    topN: Number(row.top_n) || DEFAULT_ANALYSIS_TOP_N,
    reviewNotificationChannel: asChannel(row.review_notification_channel),
    automaticSendEnabled: Boolean(row.automatic_send_enabled),
  }
}

function mapRun(row: RunRow): StoredAnalysisRun {
  const settingsSnapshot = parseJson<AnalysisSettings>(row.settings_snapshot, DEFAULT_ANALYSIS_SETTINGS)
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    dealId: String(row.deal_id),
    snapshotId: String(row.snapshot_id),
    completenessVersion: Number(row.completeness_version),
    trigger: row.trigger === "readiness" ? "readiness" : "manual",
    mode: asMode(row.mode),
    state: row.state as StoredAnalysisRun["state"],
    topN: Number(row.top_n),
    reviewNotificationChannel: asChannel(row.review_notification_channel),
    selectedFunderIds: parseJson<string[]>(row.selected_funder_ids, []),
    destinations: parseJson<AnalysisDestination[]>(row.destinations_json, []),
    settingsSnapshot: {
      mode: asMode(settingsSnapshot.mode),
      topN: Number(settingsSnapshot.topN) || DEFAULT_ANALYSIS_TOP_N,
      reviewNotificationChannel: asChannel(settingsSnapshot.reviewNotificationChannel),
      automaticSendEnabled: Boolean(settingsSnapshot.automaticSendEnabled),
    },
    reason: String(row.reason),
    queued: Boolean(row.queued),
    createdAt: String(row.created_at),
  }
}

export async function readAnalysisSettings(workspaceId: string): Promise<AnalysisSettings> {
  const row = await getDatabase().prepare<SettingsRow>(
    `SELECT * FROM mca_analysis_settings WHERE workspace_id = ?`,
  ).get(workspaceId)
  return mapSettings(row)
}

export async function upsertAnalysisSettings(
  workspaceId: string,
  settings: AnalysisSettings,
  userId: string | null,
  now: string,
): Promise<AnalysisSettings> {
  await getDatabase().prepare(`INSERT INTO mca_analysis_settings
    (workspace_id, mode, top_n, review_notification_channel, automatic_send_enabled, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      mode = excluded.mode,
      top_n = excluded.top_n,
      review_notification_channel = excluded.review_notification_channel,
      automatic_send_enabled = excluded.automatic_send_enabled,
      updated_at = excluded.updated_at,
      updated_by_user_id = excluded.updated_by_user_id`).run(
    workspaceId,
    settings.mode,
    settings.topN,
    settings.reviewNotificationChannel,
    settings.automaticSendEnabled ? 1 : 0,
    now,
    userId,
  )
  return settings
}

export async function findLatestAnalysisRun(workspaceId: string, dealId: string): Promise<StoredAnalysisRun | undefined> {
  const row = await getDatabase().prepare<RunRow>(
    `SELECT * FROM mca_analysis_runs WHERE workspace_id = ? AND deal_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(workspaceId, dealId)
  return row ? mapRun(row) : undefined
}

export async function findAnalysisRunForCompleteness(
  workspaceId: string,
  dealId: string,
  completenessVersion: number,
): Promise<StoredAnalysisRun | undefined> {
  const row = await getDatabase().prepare<RunRow>(
    `SELECT * FROM mca_analysis_runs
      WHERE workspace_id = ? AND deal_id = ? AND completeness_version = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(workspaceId, dealId, completenessVersion)
  return row ? mapRun(row) : undefined
}

export async function findMatchingAnalysisRun(input: {
  workspaceId: string
  dealId: string
  snapshotId: string
  completenessVersion: number
  mode: AnalysisMode
  topN: number
  reviewNotificationChannel: ReviewNotificationChannel
}): Promise<StoredAnalysisRun | undefined> {
  const row = await getDatabase().prepare<RunRow>(
    `SELECT * FROM mca_analysis_runs
      WHERE workspace_id = ? AND deal_id = ? AND snapshot_id = ? AND completeness_version = ?
        AND mode = ? AND top_n = ? AND review_notification_channel = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(
    input.workspaceId,
    input.dealId,
    input.snapshotId,
    input.completenessVersion,
    input.mode,
    input.topN,
    input.reviewNotificationChannel,
  )
  return row ? mapRun(row) : undefined
}

export async function insertAnalysisRun(input: StoredAnalysisRun): Promise<StoredAnalysisRun> {
  await getDatabase().prepare(`INSERT INTO mca_analysis_runs
    (id, workspace_id, deal_id, snapshot_id, completeness_version, trigger, mode, state, top_n,
     review_notification_channel, selected_funder_ids, destinations_json, settings_snapshot, reason, queued, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, deal_id, snapshot_id, completeness_version, mode, top_n, review_notification_channel)
    DO NOTHING`).run(
    input.id,
    input.workspaceId,
    input.dealId,
    input.snapshotId,
    input.completenessVersion,
    input.trigger,
    input.mode,
    input.state,
    input.topN,
    input.reviewNotificationChannel,
    JSON.stringify(input.selectedFunderIds),
    JSON.stringify(input.destinations),
    JSON.stringify(input.settingsSnapshot),
    input.reason,
    input.queued ? 1 : 0,
    input.createdAt,
  )
  return await findMatchingAnalysisRun({
    workspaceId: input.workspaceId,
    dealId: input.dealId,
    snapshotId: input.snapshotId,
    completenessVersion: input.completenessVersion,
    mode: input.mode,
    topN: input.topN,
    reviewNotificationChannel: input.reviewNotificationChannel,
  }) ?? input
}
