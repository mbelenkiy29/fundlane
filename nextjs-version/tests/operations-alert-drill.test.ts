import assert from "node:assert/strict"
import test from "node:test"

import {
  assertAlertDrillGuards,
  main,
  runAlertDrill,
  sanitizeAlertDrillEvidence,
} from "../scripts/ops/alert-drill"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const localUrl = "postgresql://operator:test@127.0.0.1:5432/disposable_alert_drill"
const enabledEnv = {
  MCA_OPS_ALERT_DRILL_ENABLED: "true",
  MCA_OPS_ALERT_DRILL_DATABASE_URL: localUrl,
}

test("alert drill guards require the exact flag, confirmation, and dedicated URL", async () => {
  for (const value of [undefined, "false", "TRUE", "1"])
    assert.throws(
      () =>
        assertAlertDrillGuards({
          env: { ...enabledEnv, MCA_OPS_ALERT_DRILL_ENABLED: value },
          argv: ["--confirm"],
        }),
      /MCA_OPS_ALERT_DRILL_ENABLED=true/
    )
  assert.throws(
    () => assertAlertDrillGuards({ env: enabledEnv, argv: [] }),
    /--confirm/
  )
  assert.throws(
    () =>
      assertAlertDrillGuards({
        env: { MCA_OPS_ALERT_DRILL_ENABLED: "true" },
        argv: ["--confirm"],
      }),
    /already migrated disposable loopback/
  )
  for (const url of [
    "postgresql://operator:test@database.internal/drill",
    "postgresql://operator:test@192.0.2.1/drill",
  ])
    assert.throws(
      () =>
        assertAlertDrillGuards({
          env: { ...enabledEnv, MCA_OPS_ALERT_DRILL_DATABASE_URL: url },
          argv: ["--confirm"],
        }),
      /only localhost/
    )
  assert.throws(
    () =>
      assertAlertDrillGuards({
        env: {
          ...enabledEnv,
          MCA_OPS_ALERT_DRILL_DATABASE_URL:
            "postgresql://drubsfvhlggmtyiigwxy@127.0.0.1/drill",
        },
        argv: ["--confirm"],
      }),
    /production Supabase project/
  )

  let connected = false
  await assert.rejects(
    main([], enabledEnv, async () => {
      connected = true
      throw new Error("must not connect")
    }),
    /--confirm/
  )
  assert.equal(connected, false)
})

function healthResponse(websiteOk: boolean): Response {
  if (websiteOk)
    return Response.json({ databaseOk: true, databaseMs: 1, deployment: "drill" })
  let reads = 0
  return {
    status: 503,
    get ok() {
      return ++reads > 1
    },
    json: async () => ({ databaseOk: true, databaseMs: 1, deployment: "drill" }),
  } as Response
}

test("alert drill uses real monitor attempts and rolls every row back", async () => {
  const database = await createPostgresTestDatabase("operations_alert_drill")
  try {
    let healthChecks = 0
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes("/api/internal/health"))
        return healthResponse(healthChecks++ >= 3)
      requests.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      })
      return new Response(null, { status: 202 })
    }
    const evidence = await runAlertDrill(database, fetcher)
    assert.deepEqual(
      evidence.attempts.map(({ kind, state }) => ({ kind, state })),
      [
        { kind: "opening", state: "accepted" },
        { kind: "recovery", state: "accepted" },
      ]
    )
    assert.equal(new Set(evidence.attempts.map((attempt) => attempt.id)).size, 2)
    assert.equal(requests.length, 2)
    for (const [index, request] of requests.entries()) {
      assert.deepEqual(Object.keys(request.body).sort(), [
        "actionUrl",
        "data",
        "expiresAt",
        "recipient",
        "template",
      ])
      assert.equal(request.body.template, "operations_alert")
      assert.equal(request.body.actionUrl, "https://offline.invalid/admin/status")
      assert.equal(request.body.recipient, "operator@offline.invalid")
      assert.deepEqual(Object.keys(request.body.data as object).sort(), [
        "component",
        "summary",
        "time",
      ])
      assert.equal(
        (request.body.data as { component: string }).component,
        "website"
      )
      assert.equal(
        request.headers.get("idempotency-key"),
        evidence.attempts[index]?.id
      )
      assert.equal(
        request.headers.get("x-correlation-id"),
        evidence.attempts[index]?.id
      )
    }
    const serialized = JSON.stringify(evidence)
    for (const secret of ["operator@", "webhook.offline", "postgresql://"])
      assert.equal(serialized.includes(secret), false)
    assert.equal(evidence.rollbackStatus, "rolled_back")
    assert.equal(
      (await database.query("SELECT * FROM mca_private.ops_alert_attempts"))
        .rowCount,
      0
    )
    assert.equal(
      (await database.query("SELECT * FROM mca_private.ops_incidents")).rowCount,
      0
    )
  } finally {
    await database.close()
  }
})

test("alert drill records one unknown timeout without resending and still rolls back", async () => {
  const database = await createPostgresTestDatabase("operations_alert_timeout")
  try {
    let healthChecks = 0
    let webhookCalls = 0
    const evidence = await runAlertDrill(database, async (url) => {
      if (String(url).includes("/api/internal/health"))
        return healthResponse(healthChecks++ >= 3)
      webhookCalls += 1
      if (webhookCalls === 1) throw new Error("mock timeout after send")
      return new Response(null, { status: 202 })
    })
    assert.equal(webhookCalls, 2)
    assert.deepEqual(
      evidence.attempts.map(({ kind, state }) => ({ kind, state })),
      [
        { kind: "opening", state: "unknown" },
        { kind: "recovery", state: "accepted" },
      ]
    )
    assert.equal(
      (await database.query("SELECT * FROM mca_private.ops_alert_attempts"))
        .rowCount,
      0
    )
  } finally {
    await database.close()
  }
})

test("alert drill evidence sanitization allowlists output fields", () => {
  const evidence = sanitizeAlertDrillEvidence({
    attempts: [
      {
        id: "postgresql://secret",
        kind: "opening",
        state: "accepted",
        databaseUrl: "postgresql://secret",
      },
    ],
    requestCount: 1,
    elapsedMs: 2.2,
    recipient: "secret@example.test",
  } as never)
  assert.deepEqual(Object.keys(evidence), [
    "schemaVersion",
    "drillKind",
    "component",
    "attempts",
    "requestCount",
    "rollbackStatus",
    "elapsedMs",
  ])
  assert.equal(JSON.stringify(evidence).includes("secret"), false)
})
