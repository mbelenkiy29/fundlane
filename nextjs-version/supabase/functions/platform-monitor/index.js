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
var escapeHtml = (value) => value.replace(
  /[&<>"']/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
);
var stringValue = (data, key) => typeof data?.[key] === "string" && data[key].trim() ? data[key].trim() : void 0;
function renderEmailContent(message) {
  const data = message.data;
  const client = stringValue(data, "clientName");
  const employee = stringValue(data, "employeeName");
  const expiry = `This link expires at ${message.expiresAt}.`;
  let subject, paragraph, cta;
  const details = [];
  switch (message.template) {
    case "application_invitation":
      subject = "Complete your business funding application";
      paragraph = `${client ? `Hi ${client}, ` : ""}${employee ? `${employee} invited you` : "You\u2019ve been invited"} to complete your business funding application. Have your business details and recent bank statements ready.`;
      cta = "Start application";
      break;
    case "application_invitation_reminder": {
      subject = "Finish your business funding application";
      paragraph = `${client ? `Hi ${client}, ` : ""}this is a reminder to finish the business funding application${employee ? ` ${employee} invited you to complete` : " you were invited to complete"}.`;
      cta = "Continue application";
      const form = stringValue(data, "formName"), step = stringValue(data, "lastStep");
      if (form) details.push(`Form: ${form}.`);
      if (step) details.push(`Current step: ${step}.`);
      break;
    }
    case "workspace_invitation":
      subject = "You\u2019re invited to join Fundlane";
      paragraph = "You\u2019ve been invited to join a company workspace in Fundlane.";
      cta = "Accept invitation";
      break;
    case "account_recovery":
      subject = "Reset your Fundlane password";
      paragraph = "We received a request to reset your Fundlane password. If you did not request this, you can ignore this email.";
      cta = "Reset password";
      break;
    case "company_email_verification":
      subject = "Verify your company email";
      paragraph = "Verify your email address to continue setting up your company in Fundlane.";
      cta = "Verify company email";
      break;
    case "funder_analysis_review":
      subject = "Review Fundlane funder analysis";
      paragraph = "A funder analysis is ready for your review. Review the recommendations and confirm your selection.";
      cta = "Review analysis";
      break;
    case "ai_credit_alert": {
      const exhausted = stringValue(data, "kind") === "exhausted" || data?.total === 0;
      subject = exhausted ? "Fundlane AI credits are exhausted" : "Fundlane AI credits are running low";
      paragraph = exhausted ? "Fundlane AI credits are exhausted." : "Fundlane AI credits are running low.";
      cta = "Review AI credits";
      for (const [key, label] of [
        ["companyName", "Company"],
        ["userName", "User"],
        ["total", "Remaining"],
        ["allowance", "Allowance"],
        ["resetAt", "Reset"]
      ]) {
        const value = data?.[key];
        if (typeof value === "string" || typeof value === "number")
          details.push(`${label}: ${String(value)}.`);
      }
      break;
    }
    case "operations_alert": {
      const component = stringValue(data, "component") ?? "platform";
      subject = `Fundlane operations alert: ${component}`;
      paragraph = stringValue(data, "summary") ?? "A platform component needs attention.";
      cta = "Open platform status";
      details.push(
        `Component: ${component}.`,
        `Time: ${stringValue(data, "time") ?? "Unavailable"}.`
      );
      break;
    }
    default: {
      const exhaustive = message.template;
      throw new Error(`Unsupported email template: ${exhaustive}`);
    }
  }
  const text = [
    paragraph,
    ...details,
    `${cta}: ${message.actionUrl}`,
    expiry
  ].join("\n\n");
  const html = `<p>${escapeHtml(paragraph)}</p>${details.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}<p><a href="${escapeHtml(message.actionUrl)}">${escapeHtml(cta)}</a></p><p>${escapeHtml(expiry)}</p>`;
  return { subject, text, html };
}
function usesendOrigin(configured) {
  if (!configured) return "https://app.usesend.com";
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("MCA_USESEND_BASE_URL must be an HTTPS origin.");
  return url.origin;
}
async function requestSystemEmail(input) {
  const resend = input.provider === "resend";
  const response = await (input.fetchImpl ?? fetch)(
    resend ? "https://api.resend.com/emails" : new URL("/api/v1/emails", usesendOrigin(input.baseUrl)).href,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "Idempotency-Key": input.idempotencyKey.slice(0, 256),
        // useSend's edge rejects default runtime agents; match the app's useSend client.
        ...resend ? {} : {
          "user-agent": "Mozilla/5.0 (compatible; MCA-Intake/1.0; +https://fundlane.io)"
        }
      },
      body: JSON.stringify(
        resend ? {
          from: input.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          html: input.html,
          ...input.replyTo !== void 0 ? { reply_to: input.replyTo } : {}
        } : {
          to: input.to,
          from: input.from,
          subject: input.subject,
          text: input.text,
          html: input.html,
          ...input.replyTo !== void 0 ? { replyTo: input.replyTo } : {}
        }
      ),
      redirect: "error",
      signal: AbortSignal.timeout(15e3)
    }
  );
  const body = await response.json().catch(() => void 0);
  const error = body?.error && typeof body.error === "object" ? body.error : void 0;
  const id = resend ? body?.id : body?.emailId ?? body?.id;
  return {
    status: response.status,
    ...typeof id === "string" && id.trim() ? { emailId: id } : {},
    ...typeof error?.code === "string" ? { errorCode: error.code } : typeof body?.code === "string" ? { errorCode: body.code } : {}
  };
}

// src/lib/mca/operations/runtime-signals.ts
async function runtimeSignals(db, config) {
  if (!config.recoveryAlerts) return {};
  const queries = {
    billing: `SELECT COALESCE(greatest(0,extract(epoch FROM now()-min(available_at::timestamptz)))::int,0) "queueSeconds" FROM company_billing_notifications WHERE delivered_at IS NULL AND available_at::timestamptz<=now()`,
    // Submission failures can finish their background dispatch successfully: inspect the business outcome.
    submissions: `SELECT count(*)::int failures FROM mca_submission_attempts WHERE state='failed' AND created_at::timestamptz>=now()-interval '10 minutes'`,
    // Voice is request/callback driven, with no worker queue or heartbeat.
    voice: `SELECT count(*)::int failures FROM voice_calls WHERE state='failed' AND terminal_at::timestamptz>=now()-interval '10 minutes'`
  };
  if (config.emailRuntimeEnabled) queries.email = `SELECT
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(next_attempt_at::timestamptz)))::int FROM mca_email_messages WHERE direction='outbound' AND state='queued' AND next_attempt_at::timestamptz<=now()),0) "queueSeconds",
    (SELECT extract(epoch FROM now()-last_completed_at)::int FROM mca_email_runtime_lease WHERE id=1) "heartbeatSeconds",
    (SELECT count(*)::int FROM mca_email_senders WHERE state IN ('expired','revoked')) reconnect,
    (SELECT count(*)::int FROM mca_email_conversations WHERE sync_error IS NOT NULL AND sync_error_at>=now()-interval '10 minutes') failures,
    (SELECT count(*)::int FROM (
      SELECT s.id FROM mca_email_senders s JOIN mca_email_conversations c ON c.sender_id=s.id
      WHERE s.state='verified' AND s.purpose='merchant' AND s.provider IN ('google','microsoft') AND s.credential_cipher IS NOT NULL
      GROUP BY s.id HAVING COALESCE(max(c.last_synced_at::timestamptz),min(c.created_at::timestamptz))<now()-interval '30 minutes'
    ) stale_senders) "staleSyncs"`;
  if (config.smsRuntimeEnabled) queries.sms = `SELECT
    (SELECT count(*)::int FROM sms_operations WHERE state='running' AND lease_until::timestamptz<now()) "expiredLeases",
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(created_at::timestamptz)))::int FROM sms_operations WHERE state='queued'),0) "queueSeconds",
    ((SELECT count(*) FROM sms_operations WHERE state IN ('failed','needs_review') AND error_code IS DISTINCT FROM 'company_paused' AND updated_at::timestamptz>=now()-interval '10 minutes')+
     (SELECT count(*) FROM mca_sms_messages WHERE state IN ('failed','unknown') AND updated_at::timestamptz>=now()-interval '10 minutes'))::int failures`;
  if (config.calendarRuntimeEnabled) queries.calendar = `SELECT
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(next_sync_at::timestamptz)))::int FROM mca_calendar_connections WHERE status<>'reconnect' AND next_sync_at::timestamptz<=now()),0) "queueSeconds",
    (SELECT count(*)::int FROM mca_calendar_connections WHERE status IN ('error','reconnect')) failures,
    (SELECT count(*)::int FROM mca_calendar_connections WHERE status<>'reconnect' AND COALESCE(last_sync_at,created_at)::timestamptz<now()-interval '10 minutes') "staleSyncs"`;
  if (config.privateEmailRuntimeEnabled) queries.receipts = `SELECT
    (SELECT count(*)::int FROM intake_receipts WHERE state IN ('pending','failed') AND lease_token IS NOT NULL AND lease_expires_at::timestamptz<now()) "expiredLeases",
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(updated_at::timestamptz)))::int FROM intake_receipts WHERE state IN ('pending','failed') AND last_error IS DISTINCT FROM 'company_paused_review_required' AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at::timestamptz<=now())),0) "queueSeconds",
    (SELECT count(*)::int FROM intake_receipts WHERE state='failed' AND last_error IS DISTINCT FROM 'company_paused_review_required' AND updated_at::timestamptz>=now()-interval '10 minutes') failures`;
  if (config.notificationRuntimeEnabled) queries.notifications = `SELECT
    (SELECT count(*)::int FROM mca_notifications WHERE state='sending' AND lease_until::timestamptz<now()) "expiredLeases",
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(greatest(next_attempt_at::timestamptz,scheduled_for::timestamptz))))::int FROM mca_notifications WHERE state IN ('queued','retry') AND attempts<3 AND next_attempt_at::timestamptz<=now() AND scheduled_for::timestamptz<=now()),0) "queueSeconds",
    (SELECT count(*)::int FROM mca_notifications WHERE state IN ('failed','uncertain') AND updated_at::timestamptz>=now()-interval '10 minutes') failures`;
  if (config.documentRuntimeEnabled) queries.documents = `SELECT count(*)::int failures FROM mca_background_jobs WHERE kind IN ('document_upload','document_scan','draft_scan','assistant_scan','draft_extract','intake_process') AND state='failed' AND updated_at::timestamptz>=now()-interval '10 minutes'`;
  const signals = {};
  for (const [name, query] of Object.entries(queries)) {
    const [row] = await db.query(query);
    if (!row) throw new Error("Runtime aggregate unavailable");
    signals[name] = row;
  }
  return signals;
}

// src/lib/mca/operations/contracts.ts
function documentWorkerReady(metrics) {
  return metrics.documentWorkerHeartbeatAgeSeconds != null && metrics.documentWorkerHeartbeatAgeSeconds <= 90;
}
function safeIdentifier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
}
function positiveThreshold(value, fallback) {
  if (!value || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 86400 ? parsed : fallback;
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
async function queueMetrics(db, documentRuntimeEnabled = false) {
  const [row] = await db.query(`SELECT
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='queued') queued,
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='running') running,
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='failed') failed,
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='queued' AND attempts>0) retrying,
    (SELECT count(*)::int FROM mca_background_jobs WHERE kind='billing_reconcile' AND state='queued' AND attempts>0) "billingRetrying",
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
    (SELECT count(*)::int FROM mca_private.ops_errors WHERE occurred_at>=now()-interval '5 minutes') "recentErrors",
    (SELECT EXTRACT(EPOCH FROM now() - document_worker_heartbeat_at)::int FROM mca_private.ops_control WHERE id) AS "documentWorkerHeartbeatAgeSeconds",
    (SELECT count(*)::int FROM mca_background_jobs WHERE $1::boolean AND kind IN ('document_upload','document_scan','draft_scan','assistant_scan','draft_extract','intake_process') AND state='failed') AS "documentFailed",
    (SELECT count(*)::int FROM mca_background_jobs WHERE $1::boolean AND kind IN ('document_upload','document_scan','draft_scan','assistant_scan','intake_process') AND error_code='scanner_unavailable' AND state IN ('queued','failed')) AS "scannerUnavailable",
    COALESCE((SELECT jsonb_object_agg(kind,age) FROM (SELECT kind,COALESCE(greatest(0,extract(epoch FROM now()-min(available_at::timestamptz) FILTER (WHERE state='queued' AND available_at::timestamptz<=now())))::int,0) age FROM mca_background_jobs GROUP BY kind) q),'{}'::jsonb) AS "queueAgeByKind",
    (SELECT count(*)::int FROM company_billing_notifications WHERE delivered_at IS NULL AND attempts>0 AND available_at::timestamptz<=now()) AS "billingMaintenanceFailures",
    (SELECT count(*)::int FROM mca_assistant_runs WHERE created_at::timestamptz>=now()-interval '1 hour') AS "assistantRuns"`, [documentRuntimeEnabled]);
  return row;
}
function recoveryRules(metrics, config) {
  if (!config.recoveryAlerts) return [];
  const thresholds = config.thresholds ?? { workerSeconds: 90, queueSeconds: 600, providerFailures: 5, billingFailures: 1, assistantRuns: 100 };
  const rules = [
    ["sender_provider_failures", metrics.recentEmailFailures >= thresholds.providerFailures || metrics.reconnect >= thresholds.providerFailures, 1],
    ["billing_maintenance_failures", (metrics.billingMaintenanceFailures ?? 0) >= thresholds.billingFailures, 1]
  ];
  if (config.assistantEnabled) rules.push(["assistant_usage", (metrics.assistantRuns ?? 0) >= thresholds.assistantRuns, 1]);
  for (const [runtime, signal] of Object.entries(metrics.runtimeSignals ?? {})) {
    if (signal.queueSeconds !== void 0) rules.push([`${runtime}_queue_age`, signal.queueSeconds > thresholds.queueSeconds, 3]);
    if (signal.failures !== void 0) rules.push([`${runtime}_provider_failures`, signal.failures >= thresholds.providerFailures, 1]);
    if (signal.staleSyncs !== void 0) rules.push([`${runtime}_stale_sync`, signal.staleSyncs > 0, 3]);
    if (signal.reconnect !== void 0) rules.push([`${runtime}_senders`, signal.reconnect >= thresholds.providerFailures, 1]);
    if (signal.expiredLeases !== void 0) rules.push([`${runtime}_expired_leases`, signal.expiredLeases > 0, 3]);
    if ("heartbeatSeconds" in signal) rules.push([`${runtime}_worker`, signal.heartbeatSeconds == null || signal.heartbeatSeconds < 0 || signal.heartbeatSeconds > 600, 3]);
  }
  for (const [kind, age] of Object.entries(metrics.queueAgeByKind ?? {})) {
    if (/^[a-z_]{1,50}$/.test(kind) && Number.isFinite(age))
      rules.push([`queue_age_${kind}`, age > (thresholds.queueByKind?.[kind] ?? thresholds.queueSeconds), 3]);
  }
  return rules;
}
function workerHeartbeatStale(metrics, config) {
  if (!config.recoveryAlerts) return !documentWorkerReady(metrics);
  return metrics.documentWorkerHeartbeatAgeSeconds === null || metrics.documentWorkerHeartbeatAgeSeconds > (config.thresholds?.workerSeconds ?? 90);
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
      metrics = await queueMetrics(db, config.documentRuntimeEnabled);
      if (config.recoveryAlerts) metrics.runtimeSignals = await runtimeSignals(db, config);
    } catch {
      metrics = null;
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
      ["billing_reconciliation", config.billingReconciliationAlertsEnabled && metrics ? metrics.billingRetrying > 0 : null, 1],
      ["queue_age", metrics ? !config.recoveryAlerts && metrics.oldestSeconds > 600 : null, 3],
      ["expired_leases", metrics ? metrics.expired > 0 : null, 3],
      ["ambiguous_email", metrics ? metrics.emailUnknown > 0 : null, 1],
      ["email_failures", metrics ? metrics.recentEmailFailures >= 5 : null, 1],
      [
        "document_worker",
        metrics ? workerHeartbeatStale(metrics, config) : null,
        3
      ],
      ["metrics_unavailable", metrics === null, 3]
    ];
    if (metrics) rules.push(...recoveryRules(metrics, config));
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
    const providerReady = config.systemProviderEnabled && config.systemProvider && config.systemApiKey && config.systemFrom;
    if (config.alerts && config.recipient && (config.webhook || providerReady)) {
      const [pending] = await db.query(
        `WITH claimed AS (UPDATE mca_private.ops_incidents SET delivery_state='sending',last_attempt_at=now(),last_sent_at=now()
        WHERE component=(SELECT component FROM mca_private.ops_incidents WHERE pending_kind IS NOT NULL AND delivery_state='pending' ORDER BY last_attempt_at NULLS FIRST,component LIMIT 1)
        AND EXISTS(SELECT 1 FROM mca_private.ops_control WHERE lease_token=$1 AND lease_until>now())
        RETURNING component,pending_kind,pending_id) INSERT INTO mca_private.ops_alert_attempts(id,component,kind,state) SELECT pending_id,component,pending_kind,'sending' FROM claimed RETURNING component,kind AS pending_kind,id::text AS pending_id`,
        [lease]
      );
      if (pending) {
        try {
          const message = {
            recipient: config.recipient,
            template: "operations_alert",
            actionUrl: new URL("/admin/status", config.origin).href,
            expiresAt: new Date(Date.now() + 864e5).toISOString(),
            data: {
              component: pending.component,
              time: now,
              summary: `${pending.pending_kind}: ${pending.component}`
            }
          };
          let state;
          if (config.webhook) {
            const response = await sendTransactionalWebhook(config.webhook, config.webhookToken, message, String(pending.pending_id), fetcher, 8e3);
            state = response.ok ? "accepted" : response.status >= 500 ? "unknown" : "rejected";
          } else {
            const replyTo = config.systemReplyTo?.includes("@") ? config.systemReplyTo : void 0;
            const response = await requestSystemEmail({ provider: config.systemProvider, apiKey: config.systemApiKey, from: config.systemFrom, to: config.recipient, ...renderEmailContent(message), idempotencyKey: String(pending.pending_id), fetchImpl: fetcher, baseUrl: config.systemBaseUrl, ...replyTo !== void 0 ? { replyTo } : {} });
            state = response.status >= 200 && response.status < 300 && response.emailId ? "accepted" : [400, 401, 403, 422, 429].includes(response.status) ? "rejected" : "unknown";
          }
          await finishAlert(
            db,
            String(pending.component),
            String(pending.pending_id),
            state
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
var systemProvider = env("MCA_SYSTEM_EMAIL_PROVIDER") === "resend" ? "resend" : "usesend";
function queueThresholds() {
  try {
    const raw = JSON.parse(env("MCA_OPERATIONS_QUEUE_AGE_BY_KIND_SECONDS") ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([kind, value]) => /^[a-z_]{1,50}$/.test(kind) && Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 86400));
  } catch {
    return {};
  }
}
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
        documentRuntimeEnabled: env("MCA_DOCUMENT_JOB_RUNTIME") === "vercel_cron" || env("MCA_NATIVE_DOCUMENT_EXECUTOR") === "true",
        billingReconciliationAlertsEnabled: env("MCA_BILLING_RECONCILIATION_ALERTS_ENABLED") === "true",
        recoveryAlerts: env("MCA_OPERATIONS_RECOVERY_ALERTS_ENABLED") === "true",
        assistantEnabled: env("MCA_ASSISTANT_ENABLED") === "true",
        emailRuntimeEnabled: env("MCA_EMAIL_CONVERSATIONS_RUNTIME") === "vercel_cron",
        smsRuntimeEnabled: env("MCA_SMS_CRON_ENABLED") === "true",
        calendarRuntimeEnabled: env("MCA_CALENDAR_GOOGLE_ENABLED") === "true" && env("MCA_CALENDAR_RUNTIME") === "vercel_cron",
        privateEmailRuntimeEnabled: env("MCA_PRIVATE_EMAIL_CRON_ENABLED") === "true" && env("MCA_PRIVATE_EMAIL_DELIVERY_ENABLED") === "true",
        notificationRuntimeEnabled: env("MCA_NOTIFICATION_RUNTIME") === "enabled",
        thresholds: {
          workerSeconds: positiveThreshold(env("MCA_OPERATIONS_WORKER_STALE_SECONDS"), 90),
          queueSeconds: positiveThreshold(env("MCA_OPERATIONS_QUEUE_AGE_SECONDS"), 600),
          queueByKind: queueThresholds(),
          providerFailures: positiveThreshold(env("MCA_OPERATIONS_PROVIDER_FAILURES"), 5),
          billingFailures: positiveThreshold(env("MCA_OPERATIONS_BILLING_FAILURES"), 1),
          assistantRuns: positiveThreshold(env("MCA_OPERATIONS_ASSISTANT_RUNS_PER_HOUR"), 100)
        },
        recipient: env("MCA_OPERATIONS_ALERT_EMAIL"),
        webhook: env("MCA_EMAIL_WEBHOOK_URL"),
        webhookToken: env("MCA_EMAIL_WEBHOOK_TOKEN"),
        systemProviderEnabled: env("MCA_TRANSACTIONAL_EMAIL_SYSTEM_PROVIDER_ENABLED") === "true",
        systemProvider,
        systemApiKey: env(systemProvider === "resend" ? "MCA_RESEND_API_KEY" : "MCA_USESEND_API_KEY")?.trim(),
        systemFrom: (systemProvider === "resend" ? env("MCA_RESEND_FROM")?.trim() || env("MCA_USESEND_FROM") : env("MCA_USESEND_FROM"))?.trim(),
        systemReplyTo: env("MCA_SYSTEM_EMAIL_REPLY_TO")?.trim() || void 0,
        systemBaseUrl: env("MCA_USESEND_BASE_URL")?.trim() || void 0
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
