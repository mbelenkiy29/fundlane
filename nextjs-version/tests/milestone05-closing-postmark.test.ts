import test from "node:test"
import assert from "node:assert/strict"
import { createPostmarkClosingTransport, postmarkConnectionConfigured, type ClosingTransportRequest } from "../src/lib/mca/closing/delivery"
import { deliverSenderTest, setSenderDeliveryFetchForTests } from "../src/lib/mca/senders/delivery"

const request = (overrides: Partial<ClosingTransportRequest> = {}): ClosingTransportRequest => ({
  kind: "contract_request",
  channel: "email",
  senderId: "verified-submission-sender",
  sender: { fromName: "MCA Closing", fromAddress: "mike@sentineltechsolutions.io" },
  recipient: "synthetic-recipient@example.test",
  subject: "Contract request · MCA-1042",
  body: "This is the exact immutable preview body.\nSecond line.",
  correlationId: "delivery-correlation-42",
  recordId: "contract-workflow-42",
  attemptKey: "contract-attempt-42",
  payloadHash: "a".repeat(64),
  attachments: [{
    id: "document-42", version: 3, checksum: "b".repeat(64), filename: "voided-check.pdf",
    mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF synthetic exact bytes")),
    url: "https://app.example.test/api/mca/closing/artifacts/scoped-token", expiresAt: "2099-01-01T00:00:00.000Z",
  }],
  ...overrides,
})

test("Postmark closing transport sends exact preview and authorized attachment bytes and retains MessageID", async () => {
  let calls = 0
  const transport = createPostmarkClosingTransport({
    serverToken: "synthetic-postmark-server-token",
    allowedFromAddresses: ["mike@sentineltechsolutions.io"],
    fetchImpl: async (input, init) => {
      calls += 1
      assert.equal(String(input), "https://api.postmarkapp.com/email")
      assert.equal(init?.method, "POST")
      assert.equal(new Headers(init?.headers).get("x-postmark-server-token"), "synthetic-postmark-server-token")
      assert.equal(init?.redirect, "error")
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(body.From, "MCA Closing <mike@sentineltechsolutions.io>")
      assert.equal(body.To, "synthetic-recipient@example.test")
      assert.equal(body.Subject, "Contract request · MCA-1042")
      assert.equal(body.TextBody, "This is the exact immutable preview body.\nSecond line.")
      assert.deepEqual(body.Metadata, { mca_delivery_id: "delivery-correlation-42", mca_record_id: "contract-workflow-42", mca_payload_hash: "a".repeat(64) })
      assert.deepEqual(body.Attachments, [{ Name: "voided-check.pdf", Content: Buffer.from("%PDF synthetic exact bytes").toString("base64"), ContentType: "application/pdf" }])
      assert.equal(JSON.stringify(body).includes("scoped-token"), false)
      return new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: "postmark-message-42" }), { status: 200, headers: { "content-type": "application/json" } })
    },
  })
  assert.deepEqual(await transport.deliver(request()), { state: "sent", correlationId: "delivery-correlation-42", externalId: "postmark-message-42" })
  assert.equal(calls, 1)
})

test("Postmark closing transport blocks an unconfirmed From identity before network access", async () => {
  const transport = createPostmarkClosingTransport({ serverToken: "synthetic-token", allowedFromAddresses: ["confirmed@example.test"], fetchImpl: async () => { throw new Error("must not call") } })
  const result = await transport.deliver(request())
  assert.equal(result.state, "blocked")
  assert.equal(result.errorCode, "postmark_sender_unconfirmed")
})

test("Postmark readiness is scoped to an exact workspace connection entry", () => {
  const priorProvider = process.env.MCA_CLOSING_EMAIL_PROVIDER
  const priorConnections = process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON
  try {
    process.env.MCA_CLOSING_EMAIL_PROVIDER = "postmark"
    process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON = JSON.stringify([{ workspaceId: "workspace-a", senderId: "sender-a", fromAddress: "confirmed@example.test", serverToken: "synthetic-token" }])
    assert.equal(postmarkConnectionConfigured("workspace-a"), true)
    assert.equal(postmarkConnectionConfigured("workspace-b"), false)
  } finally {
    if (priorProvider === undefined) delete process.env.MCA_CLOSING_EMAIL_PROVIDER
    else process.env.MCA_CLOSING_EMAIL_PROVIDER = priorProvider
    if (priorConnections === undefined) delete process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON
    else process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON = priorConnections
  }
})

test("Postmark closing transport records explicit provider rejection without a successful identity", async () => {
  const transport = createPostmarkClosingTransport({
    serverToken: "synthetic-token", allowedFromAddresses: ["mike@sentineltechsolutions.io"],
    fetchImpl: async () => new Response(JSON.stringify({ ErrorCode: 300, Message: "Rejected synthetic-recipient@example.test with private content" }), { status: 422 }),
  })
  const result = await transport.deliver(request())
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "postmark_rejected")
  assert.equal(result.externalId, undefined)
  assert.equal(result.errorMessage?.includes("synthetic-recipient"), false)
})

test("Postmark closing transport reconciles a response-loss outcome by delivery metadata", async () => {
  const methods: string[] = []
  const transport = createPostmarkClosingTransport({
    serverToken: "synthetic-token", allowedFromAddresses: ["mike@sentineltechsolutions.io"],
    fetchImpl: async (input, init) => {
      methods.push(init?.method ?? "GET")
      if (init?.method === "POST") throw new TypeError("synthetic connection reset after request write")
      const url = new URL(String(input))
      assert.equal(url.pathname, "/messages/outbound")
      assert.equal(url.searchParams.get("metadata_mca_delivery_id"), "delivery-correlation-42")
      return new Response(JSON.stringify({ Messages: [{ MessageID: "postmark-recovered-42", Recipient: "synthetic-recipient@example.test", Metadata: { mca_delivery_id: "delivery-correlation-42", mca_payload_hash: "a".repeat(64) } }] }), { status: 200 })
    },
  })
  assert.deepEqual(await transport.deliver(request()), { state: "sent", correlationId: "delivery-correlation-42", externalId: "postmark-recovered-42" })
  assert.deepEqual(methods, ["POST", "GET"])
})

test("Postmark closing transport reconciles HTTP 5xx and rejects mismatched search evidence", async () => {
  let searchMatches = false
  const transport = createPostmarkClosingTransport({
    serverToken: "synthetic-token", allowedFromAddresses: ["mike@sentineltechsolutions.io"],
    fetchImpl: async (_input, init) => init?.method === "POST"
      ? new Response(JSON.stringify({ Message: "possibly accepted" }), { status: 503 })
      : new Response(JSON.stringify({ Messages: [{ MessageID: "untrusted-message", Recipient: "synthetic-recipient@example.test", Metadata: { mca_delivery_id: "delivery-correlation-42", mca_payload_hash: searchMatches ? "a".repeat(64) : "wrong-hash" } }] }), { status: 200 }),
  })
  const unknown = await transport.deliver(request())
  assert.equal(unknown.state, "blocked")
  assert.equal(unknown.errorCode, "provider_outcome_unknown")
  searchMatches = true
  assert.deepEqual(await transport.deliver(request()), { state: "sent", correlationId: "delivery-correlation-42", externalId: "untrusted-message" })
})

test("Postmark sender verification uses the exact workspace/sender mapping and requires provider acknowledgement", async () => {
  const priorProvider = process.env.MCA_CLOSING_EMAIL_PROVIDER
  const priorConnections = process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON
  try {
    process.env.MCA_CLOSING_EMAIL_PROVIDER = "postmark"
    process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON = JSON.stringify([{ workspaceId: "workspace-a", senderId: "sender-a", fromAddress: "mike@sentineltechsolutions.io", serverToken: "synthetic-token" }])
    setSenderDeliveryFetchForTests(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(body.From, "MCA Closing <mike@sentineltechsolutions.io>")
      assert.equal(body.To, "authorized-recipient@example.test")
      assert.equal(body.Subject, "Fundlane sender verification")
      return new Response(JSON.stringify({ ErrorCode: 0, MessageID: "postmark-test-message" }), { status: 200 })
    })
    const result = await deliverSenderTest({ workspaceId: "workspace-a", senderId: "sender-a", provider: "smtp", purpose: "merchant", fromName: "MCA Closing", fromAddress: "mike@sentineltechsolutions.io", recipient: "authorized-recipient@example.test" })
    assert.equal(result.delivery, "sent")
    assert.equal(result.providerMessageId, "postmark-test-message")
  } finally {
    setSenderDeliveryFetchForTests()
    if (priorProvider === undefined) delete process.env.MCA_CLOSING_EMAIL_PROVIDER
    else process.env.MCA_CLOSING_EMAIL_PROVIDER = priorProvider
    if (priorConnections === undefined) delete process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON
    else process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON = priorConnections
  }
})

test("Postmark closing transport reports an unreconciled network outcome as blocked and unknown", async () => {
  const transport = createPostmarkClosingTransport({
    serverToken: "synthetic-token", allowedFromAddresses: ["mike@sentineltechsolutions.io"],
    fetchImpl: async (_input, init) => init?.method === "POST"
      ? Promise.reject(new TypeError("synthetic timeout"))
      : Promise.resolve(new Response(JSON.stringify({ Messages: [] }), { status: 200 })),
  })
  const result = await transport.deliver(request())
  assert.equal(result.state, "blocked")
  assert.equal(result.errorCode, "provider_outcome_unknown")
  assert.equal(result.externalId, undefined)
})

test("Postmark closing transport treats a malformed HTTP success as unknown, never sent", async () => {
  const transport = createPostmarkClosingTransport({
    serverToken: "synthetic-token", allowedFromAddresses: ["mike@sentineltechsolutions.io"],
    fetchImpl: async (_input, init) => init?.method === "POST"
      ? Promise.resolve(new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 }))
      : Promise.resolve(new Response(JSON.stringify({ Messages: [] }), { status: 200 })),
  })
  const result = await transport.deliver(request())
  assert.equal(result.state, "blocked")
  assert.equal(result.errorCode, "provider_outcome_unknown")
  assert.equal(result.externalId, undefined)
})
