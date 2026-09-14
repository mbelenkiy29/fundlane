import "server-only"
import { withTransaction } from "../db"
import type { ErrorEvent, Health, Status, Window } from "./contracts"
import { sinceFor } from "./contracts"
export async function platformStatus(window: Window): Promise<Status> {
  const asOf = new Date().toISOString(),
    since = sinceFor(window, Date.parse(asOf))
  return withTransaction(async (db) => {
    await db.query("SET LOCAL TIME ZONE 'UTC'")
    await db.query("SET LOCAL statement_timeout='3000ms'")
    const one = async <T extends Record<string, unknown>>(
      sql: string,
      args: unknown[] = []
    ) => (await db.query<T>(sql, args)).rows[0]
    const control = await one<{ started_at: string }>(
      "SELECT started_at::text FROM mca_private.ops_control WHERE id"
    )
    if (!control) throw new Error("Operations schema unavailable")
    const latest = (await one<Record<string, unknown>>(
      "SELECT checked_at::text,website_ok,database_ok,website_ms,database_ms,deployment,metrics FROM mca_private.ops_health ORDER BY checked_at DESC LIMIT 1"
    )) as Health | undefined
    const availability = await one<{ total: number; ok: number }>(
      `SELECT count(*)::int total,count(*) FILTER(WHERE website_ok AND database_ok)::int ok FROM mca_private.ops_health WHERE checked_at >= $1`,
      [since]
    )
    const usage = await one<{
      companies: number
      new_companies: number
      active_users: number
      invitations: number
      submitted: number
      errors: number
    }>(
      `SELECT
      (SELECT count(*)::int FROM workspaces) companies,
      (SELECT count(*)::int FROM workspaces WHERE created_at >= $1) new_companies,
      (SELECT count(DISTINCT user_id)::int FROM mca_private.ops_activity WHERE last_seen_at >= $1::timestamptz) active_users,
      (SELECT count(*)::int FROM mca_application_invitations WHERE created_at >= $1) invitations,
      (SELECT count(*)::int FROM mca_application_invitations WHERE submitted_at >= $1) submitted,
      (SELECT count(*)::int FROM mca_private.ops_errors WHERE occurred_at >= $1::timestamptz) errors`,
      [since]
    )
    const health = (
      await db.query<Status["health"][number]>(
        `WITH hours AS (SELECT generate_series(date_trunc('hour',GREATEST($1::timestamptz,(SELECT started_at FROM mca_private.ops_control))),date_trunc('hour',now()), interval '1 hour') t)
      SELECT t::text time,
      (SELECT round(avg(website_ms))::int FROM mca_private.ops_health WHERE checked_at >= GREATEST(t,$1::timestamptz) AND checked_at<t+interval '1 hour' AND website_ok) "websiteMs",
      (SELECT round(avg(database_ms))::int FROM mca_private.ops_health WHERE checked_at >= GREATEST(t,$1::timestamptz) AND checked_at<t+interval '1 hour' AND database_ok) "databaseMs",
      (SELECT count(*)::int FROM mca_private.ops_errors WHERE occurred_at >= GREATEST(t,$1::timestamptz) AND occurred_at<t+interval '1 hour') errors FROM hours ORDER BY t`,
        [since]
      )
    ).rows
    const daily = (
      await db.query<Status["usage"][number]>(
        `SELECT d::date::text AS "day",
      (SELECT count(*)::int FROM mca_private.ops_activity WHERE day=d::date AND last_seen_at >= $1::timestamptz) "activeUsers",
      (SELECT count(*)::int FROM mca_application_invitations WHERE created_at::timestamptz >= GREATEST(d,$1::timestamptz) AND created_at::timestamptz < d+interval '1 day') invitations,
      (SELECT count(*)::int FROM mca_application_invitations WHERE submitted_at::timestamptz >= GREATEST(d,$1::timestamptz) AND submitted_at::timestamptz < d+interval '1 day') submitted
      FROM generate_series(date_trunc('day',GREATEST($1::timestamptz,(SELECT started_at FROM mca_private.ops_control))),date_trunc('day',now()),interval '1 day') d ORDER BY d`,
        [since]
      )
    ).rows
    const incidents = (
      await db.query<Status["incidents"][number]>(
        "SELECT component,opened_at::text,delivery_state FROM mca_private.ops_incidents WHERE opened_at IS NOT NULL OR pending_kind IS NOT NULL OR delivery_state IN ('unknown','rejected') ORDER BY component"
      )
    ).rows
    return {
      asOf,
      startedAt: control.started_at,
      window,
      latest: latest ?? null,
      stale:
        !latest || Date.parse(asOf) - Date.parse(latest.checked_at) > 180000,
      observedAvailability: availability.total
        ? availability.ok / availability.total
        : null,
      samples: availability.total,
      errors: usage.errors,
      companies: usage.companies,
      newCompanies: usage.new_companies,
      activeUsers: usage.active_users,
      invitations: usage.invitations,
      submitted: usage.submitted,
      health,
      usage: daily,
      incidents,
    }
  })
}
export async function platformErrors(
  since: string,
  component: string | null,
  before: string | null
) {
  return withTransaction(async (db) => {
    await db.query("SET LOCAL TIME ZONE 'UTC'")
    await db.query("SET LOCAL statement_timeout='3000ms'")
    return (
      await db.query<ErrorEvent>(
        `SELECT id::text,occurred_at::text,component,code,route,correlation_id,deployment FROM mca_private.ops_errors
      WHERE occurred_at >= $1::timestamptz AND ($2::text IS NULL OR component=$2)
      AND ($3::uuid IS NULL OR (occurred_at,id) < (SELECT occurred_at,id FROM mca_private.ops_errors WHERE id=$3::uuid))
      ORDER BY occurred_at DESC,id DESC LIMIT 50`,
        [since, component, before]
      )
    ).rows
  })
}
