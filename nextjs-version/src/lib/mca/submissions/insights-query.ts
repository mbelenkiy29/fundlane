import "server-only"

import { nowIso } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { getWorkspaceSettings } from "../workspaces"
import { listVisibleSubmissionRows } from "./dashboard"
import { buildSubmissionInsights, isInsightWindow, type InsightWindow, type SubmissionInsights } from "./insights"

export async function getSubmissionInsights(
  actor: DealActor,
  window: InsightWindow,
  now = nowIso()
): Promise<SubmissionInsights> {
  if (!isInsightWindow(window)) {
    throw new AppError(422, "invalid_filter", "window must be today, week, or month.")
  }
  const settings = await getWorkspaceSettings(actor.workspaceId)
  return buildSubmissionInsights({
    timezone: settings.timezone,
    window,
    nowIso: now,
    rows: await listVisibleSubmissionRows(actor),
  })
}
