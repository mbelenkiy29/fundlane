// scripts/operations/edge-entry.ts
import postgres from "npm:postgres@3.4.7";

// src/lib/mca/operations/email-transport.ts
function sendTransactionalWebhook(url, token, message, correlationId, fetcher = fetch, timeout = 1e4) {
  return fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": correlationId,
      "idempotency-key": correlationId,
      ...token ? { authorization: `Bearer ${token}` } : {}
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeout),
    redirect: "error"
  });
}

// src/lib/mca/operations/contracts.ts
function safeIdentifier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
}
function incidentTransition(previous, bad, threshold, now) {
  const badChecks = bad ? previous.bad_checks + 1 : 0;
  const goodChecks = bad ? 0 : previous.good_checks + 1;
  let opened = previous.opened_at;
  let kind = null;
  if (!previous.pending_kind) {
    if (!opened && badChecks >= threshold) {
      opened = now;
      kind = "opening";
    } else if (opened && goodChecks >= 3) {
      opened = null;
      kind = "recovery";
    } else if (opened && bad && previous.last_sent_at && Date.parse(now) - Date.parse(previous.last_sent_at) >= 216e5)
      kind = "reminder";
  }
  return { opened, badChecks, goodChecks, kind };
}

// src/lib/mca/operations/monitor.ts
async function queueMetrics(db) {
  const [row] = await db.query(`SELECT
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='queued') queued,
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='running') running,
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='failed') failed,
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='queued' AND attempts>0) retrying,
    ((SELECT count(*) FROM mca_background_jobs WHERE state='running' AND lease_expires_at::timestamptz < now()) +
     (SELECT count(*) FROM mca_email_worker_leases WHERE expires_at::timestamptz < now()))::int expired,
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(available_at::timestamptz)))::int FROM mca_background_jobs WHERE state='queued' AND available_at::timestamptz<=now()),0) AS "oldestSeconds",
    (SELECT count(*)::int FROM mca_email_messages WHERE direction='outbound' AND state IN ('queued','sending')) "emailQueued",
    ((SELECT count(*) FROM mca_email_messages WHERE direction='outbound' AND state IN ('accepted','sent'))+
      (SELECT count(*) FROM mca_application_invitation_deliveries WHERE delivery='sent'))::int "emailAccepted",
    (SELECT count(*)::int FROM mca_email_messages WHERE direction='outbound' AND state='failed') "emailFailed",
    (SELECT count(*)::int FROM mca_email_messages WHERE direction='outbound' AND state='blocked') "emailBlocked",
    (SELECT count(*)::int FROM mca_email_messages WHERE direction='outbound' AND state='unknown') "emailUnknown",
    (SELECT count(*)::int FROM mca_email_senders WHERE state IN ('expired','revoked','failed')) reconnect,
    ((SELECT count(*) FROM mca_email_messages WHERE direction='outbound' AND state='failed' AND updated_at::timestamptz>=now()-interval '10 minutes')+
      (SELECT count(*) FROM mca_background_jobs WHERE kind='application_invitation_email' AND state='failed' AND updated_at::timestamptz>=now()-interval '10 minutes'))::int "recentEmailFailures",
    (SELECT count(*)::int FROM mca_private.ops_errors WHERE occurred_at>=now()-interval '5 minutes') "recentErrors"`);
  return row;
}
async function runMonitor(db, config, fetcher = fetch) {
  if (new URL(config.origin).protocol !== "https:")
    throw new Error("HTTPS origin required");
  const lease = crypto.randomUUID();
  const claimed = await db.query(
    `UPDATE mca_private.ops_control SET lease_token=$1,lease_until=now()+interval '55 seconds',last_started_at=now() WHERE id AND (lease_until IS NULL OR lease_until<now()) AND (last_started_at IS NULL OR last_started_at<date_trunc('minute',now())) RETURNING id`,
    [lease]
  );
  if (!claimed.length) return { skipped: true };
  try {
    const now = (/* @__PURE__ */ new Date()).toISOString(), started = performance.now();
    const [previous] = await db.query(
      "SELECT checked_at::text FROM mca_private.ops_health ORDER BY checked_at DESC LIMIT 1"
    );
    if (previous && Date.now() - Date.parse(String(previous.checked_at)) > 9e4)
      await db.query(
        "UPDATE mca_private.ops_incidents SET bad_checks=0,good_checks=0"
      );
    if (!config.alerts) await db.query("UPDATE mca_private.ops_incidents SET pending_kind=NULL,pending_id=NULL,delivery_state=NULL WHERE delivery_state='pending'");
    let websiteOk = false, databaseOk = false, databaseMs = null, deployment = null;
    try {
      const response = await fetcher(
        new URL("/api/internal/health", config.origin),
        {
          headers: { authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(8e3),
          redirect: "error"
        }
      );
      const body = await response.json();
      websiteOk = response.ok && body.databaseOk === true || response.status === 503 && body.databaseOk === false;
      databaseOk = response.ok && body.databaseOk === true;
      databaseMs = databaseOk && Number.isFinite(body.databaseMs) ? Math.max(0, Math.round(body.databaseMs)) : null;
      deployment = safeIdentifier(body.deployment);
    } catch {
    }
    const websiteMs = Math.round(performance.now() - started);
    let metrics = null;
    try {
      metrics = await queueMetrics(db);
    } catch {
    }
    await db.query(
      `INSERT INTO mca_private.ops_health(checked_at,website_ok,database_ok,website_ms,database_ms,deployment,metrics) SELECT $1,$2,$3,$4,$5,$6,$7::jsonb WHERE EXISTS(SELECT 1 FROM mca_private.ops_control WHERE lease_token=$8 AND lease_until>now())`,
      [
        now,
        websiteOk,
        databaseOk,
        websiteMs,
        databaseMs,
        deployment,
        JSON.stringify(metrics),
        lease
      ]
    );
    const rules = [
      ["website", !websiteOk, 3],
      ["database", !databaseOk, 3],
      ["server_errors", metrics ? metrics.recentErrors >= 5 : null, 1],
      ["queue_age", metrics ? metrics.oldestSeconds > 600 : null, 3],
      ["expired_leases", metrics ? metrics.expired > 0 : null, 3],
      ["ambiguous_email", metrics ? metrics.emailUnknown > 0 : null, 1],
      ["email_failures", metrics ? metrics.recentEmailFailures >= 5 : null, 1],
      ["metrics_unavailable", metrics === null, 3]
    ];
    for (const [component, bad, threshold] of rules) {
      if (bad === null) continue;
      const active = await db.query(
        "SELECT id FROM mca_private.ops_control WHERE lease_token=$1 AND lease_until>now()",
        [lease]
      );
      if (!active.length) break;
      await db.query(
        "INSERT INTO mca_private.ops_incidents(component) VALUES($1) ON CONFLICT DO NOTHING",
        [component]
      );
      const [prior] = await db.query(
        `SELECT opened_at::text,bad_checks,good_checks,last_sent_at::text,pending_kind FROM mca_private.ops_incidents WHERE component=$1`,
        [component]
      );
      const next = incidentTransition(prior, bad, threshold, now);
      await db.query(
        `UPDATE mca_private.ops_incidents SET opened_at=$2,bad_checks=$3,good_checks=$4,
        pending_kind=COALESCE(pending_kind,$5),pending_id=CASE WHEN pending_kind IS NULL AND $5::text IS NOT NULL THEN $6::uuid ELSE pending_id END,
        delivery_state=CASE WHEN pending_kind IS NULL AND $5::text IS NOT NULL THEN 'pending' ELSE delivery_state END WHERE component=$1 AND EXISTS(SELECT 1 FROM mca_private.ops_control WHERE lease_token=$7 AND lease_until>now())`,
        [
          component,
          next.opened,
          next.badChecks,
          next.goodChecks,
          config.alerts ? next.kind : null,
          crypto.randomUUID(),
          lease
        ]
      );
    }
    if (config.alerts && config.recipient && config.webhook) {
      const [pending] = await db.query(
        `WITH claimed AS (UPDATE mca_private.ops_incidents SET delivery_state='sending',last_attempt_at=now(),last_sent_at=now()
        WHERE component=(SELECT component FROM mca_private.ops_incidents WHERE pending_kind IS NOT NULL AND delivery_state='pending' ORDER BY last_attempt_at NULLS FIRST,component LIMIT 1)
        AND EXISTS(SELECT 1 FROM mca_private.ops_control WHERE lease_token=$1 AND lease_until>now())
        RETURNING component,pending_kind,pending_id) INSERT INTO mca_private.ops_alert_attempts(id,component,kind,state) SELECT pending_id,component,pending_kind,'sending' FROM claimed RETURNING component,kind AS pending_kind,id::text AS pending_id`,
        [lease]
      );
      if (pending) {
        try {
          const response = await sendTransactionalWebhook(
            config.webhook,
            config.webhookToken,
            {
              recipient: config.recipient,
              template: "operations_alert",
              actionUrl: new URL("/admin/status", config.origin).href,
              expiresAt: new Date(Date.now() + 864e5).toISOString(),
              data: {
                component: pending.component,
                time: now,
                summary: `${pending.pending_kind}: ${pending.component}`
              }
            },
            String(pending.pending_id),
            fetcher,
            8e3
          );
          await finishAlert(
            db,
            String(pending.component),
            String(pending.pending_id),
            response.ok ? "accepted" : response.status >= 500 ? "unknown" : "rejected"
          );
        } catch {
          await finishAlert(
            db,
            String(pending.component),
            String(pending.pending_id),
            "unknown"
          );
        }
      }
    }
    await db.query(
      "UPDATE mca_private.ops_alert_attempts SET state='unknown' WHERE state='sending' AND attempted_at<now()-interval '2 minutes'"
    );
    await db.query(
      "UPDATE mca_private.ops_incidents SET delivery_state='unknown',pending_kind=NULL,pending_id=NULL WHERE delivery_state='sending' AND last_attempt_at<now()-interval '2 minutes'"
    );
    await db.query(
      "DELETE FROM mca_private.ops_alert_attempts WHERE id IN (SELECT id FROM mca_private.ops_alert_attempts WHERE attempted_at<now()-interval '30 days' LIMIT 5000)"
    );
    await db.query(
      "DELETE FROM mca_private.ops_health WHERE checked_at IN (SELECT checked_at FROM mca_private.ops_health WHERE checked_at<now()-interval '30 days' LIMIT 5000)"
    );
    await db.query(
      "DELETE FROM mca_private.ops_errors WHERE id IN (SELECT id FROM mca_private.ops_errors WHERE occurred_at<now()-interval '30 days' LIMIT 5000)"
    );
    await db.query(
      "DELETE FROM mca_private.ops_activity WHERE (day,user_id) IN (SELECT day,user_id FROM mca_private.ops_activity WHERE day<(now() AT TIME ZONE 'UTC')::date-30 LIMIT 5000)"
    );
    return { websiteOk, databaseOk, metricsAvailable: metrics !== null };
  } finally {
    await db.query(
      "UPDATE mca_private.ops_control SET lease_token=NULL,lease_until=NULL WHERE lease_token=$1",
      [lease]
    );
  }
}
async function finishAlert(db, component, id, state) {
  await db.query(
    `WITH finished AS (UPDATE mca_private.ops_alert_attempts SET state=$3 WHERE id=$2::uuid RETURNING id)
    UPDATE mca_private.ops_incidents SET delivery_state=$3,pending_kind=NULL,pending_id=NULL
    WHERE component=$1 AND pending_id IN (SELECT id FROM finished)`,
    [component, id, state]
  );
}

// src/lib/mca/supabase-ca.ts
var SUPABASE_DATABASE_CA = "-----BEGIN CERTIFICATE-----\nMIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL\nBQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\nc2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow\nazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\nYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\nUm9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW\nQyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q\nDmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2\nGtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi\ncvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4\nO4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt\nNaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX\nuXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt\naUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU\ntVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b\nVW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6\njB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx\nCea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2\nCMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P\no/bKiIz+Fq8=\n-----END CERTIFICATE-----\n";

// scripts/operations/edge-entry.ts
var env = (name) => Deno.env.get(name);
Deno.serve(async (request) => {
  const secret = env("MCA_MONITOR_TOKEN");
  if (request.method !== "POST" || !secret || secret.length < 32 || request.headers.get("authorization") !== `Bearer ${secret}`)
    return new Response(null, { status: 401 });
  const url = env("MCA_MONITOR_DATABASE_URL");
  if (!url || !env("MCA_APP_ORIGIN")) return new Response(null, { status: 503 });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return new Response(null, { status: 503 });
  }
  if (parsed.username.split(".")[0] !== "mca_app" || parsed.port !== "6543")
    return new Response(null, { status: 503 });
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 1,
    ssl: { rejectUnauthorized: true, ca: SUPABASE_DATABASE_CA },
    connection: {
      statement_timeout: 3e3,
      application_name: "fundlane-platform-monitor"
    }
  });
  try {
    const result = await runMonitor(
      { query: (query, values = []) => sql.unsafe(query, values) },
      {
        origin: env("MCA_APP_ORIGIN"),
        token: secret,
        alerts: env("MCA_OPERATIONS_ALERTS_ENABLED") === "true",
        recipient: env("MCA_OPERATIONS_ALERT_EMAIL"),
        webhook: env("MCA_EMAIL_WEBHOOK_URL"),
        webhookToken: env("MCA_EMAIL_WEBHOOK_TOKEN")
      }
    );
    return Response.json(result);
  } catch {
    console.error(JSON.stringify({ event: "platform_monitor_failed" }));
    return new Response(null, { status: 503 });
  } finally {
    await sql.end({ timeout: 1 }).catch(() => void 0);
  }
});
