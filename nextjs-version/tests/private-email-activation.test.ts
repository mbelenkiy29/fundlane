import "./helpers/business-auth"
import test from "node:test"
import assert from "node:assert/strict"
import { emailIntakeReadiness, privateEmailDeliveryEnabled, privateEmailIntakeEnabled, privateEmailUiEnabled } from "../src/lib/mca/intake/email-readiness"
import { ingestEmailDelivery, deliverPendingReceipts } from "../src/lib/mca/intake/email"
import { invitationEmailEnabled } from "../src/lib/mca/applications/service"
import { GET as emailCron } from "../src/app/api/cron/private-email/route"

test("private email defaults off and rejects ingestion, receipt sends, and cron without contacting providers", async () => {
  const names = ["MCA_PRIVATE_EMAIL_INTAKE_ENABLED", "MCA_PRIVATE_EMAIL_DELIVERY_ENABLED", "MCA_APPLICATION_INVITATION_EMAIL_ENABLED", "MCA_EMAIL_SENDER_VERIFIED", "MCA_PRIVATE_EMAIL_CRON_ENABLED"] as const
  const prior = names.map(name => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    assert.equal(privateEmailIntakeEnabled(), false)
    assert.equal(privateEmailDeliveryEnabled(), false)
    assert.equal(privateEmailUiEnabled(), false)
    assert.equal(invitationEmailEnabled(), false)
    await assert.rejects(() => ingestEmailDelivery({ integrationId: "absent", request: new Request("https://example.test"), rawBody: "{}", appOrigin: "https://example.test" }), { code: "email_intake_disabled" })
    await assert.rejects(() => deliverPendingReceipts({ fetchImpl: async () => { throw new Error("provider contacted") } }), { code: "receipt_delivery_disabled" })
    assert.deepEqual(await (await emailCron(new Request("https://example.test/api/cron/private-email"))).json(), { enabled: false })
    process.env.MCA_PRIVATE_EMAIL_CRON_ENABLED = "true"
    process.env.CRON_SECRET = "synthetic-cron-secret"
    assert.equal((await emailCron(new Request("https://example.test/api/cron/private-email"))).status, 401)
    assert.deepEqual(await (await emailCron(new Request("https://example.test/api/cron/private-email", {
      headers: { authorization: "Bearer synthetic-cron-secret" },
    }))).json().then((body: { enabled: boolean; jobs: number; receipts: number }) => [body.enabled, body.jobs, body.receipts]), [true, 0, 0])
  } finally {
    names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index] })
    delete process.env.CRON_SECRET
  }
})

test("admin readiness requires an address, admission secret, sender rules, verified sender, and transport", () => {
  const names = ["MCA_PRIVATE_EMAIL_INTAKE_ENABLED", "MCA_PRIVATE_EMAIL_DELIVERY_ENABLED", "MCA_EMAIL_SENDER_VERIFIED", "MCA_INTAKE_RECEIPT_WEBHOOK_URL", "MCA_INTAKE_RECEIPT_WEBHOOK_TOKEN"] as const
  const prior = names.map(name => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    const input = { enabled: true, emailGateway: "postmark", providerEvidenceHash: "fixture" }
    const missing = emailIntakeReadiness(input)
    assert.ok(missing.includes("Inbound address is missing"))
    assert.ok(missing.includes("Inbound webhook secret is missing"))
    assert.ok(missing.includes("Allowed sender rules are missing"))
    assert.ok(missing.includes("Outbound sender verification is unconfirmed"))
    for (const name of names) process.env[name] = name === "MCA_INTAKE_RECEIPT_WEBHOOK_URL" ? "https://mail.example.test/receipt" : "true"
    assert.deepEqual(emailIntakeReadiness({ ...input, inboundAddress: "intake@inbound.postmarkapp.com", admissionSecretHash: "hash", senderRules: ["@trusted.test"] }), [])
    delete process.env.MCA_INTAKE_RECEIPT_WEBHOOK_TOKEN
    assert.ok(emailIntakeReadiness({ ...input, inboundAddress: "intake@inbound.postmarkapp.com", admissionSecretHash: "hash", senderRules: ["@trusted.test"] }).includes("Receipt delivery receiver token is missing"))
  } finally { names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index] }) }
})
