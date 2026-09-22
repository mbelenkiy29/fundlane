import test from "node:test"
import assert from "node:assert/strict"
import { captureIntakeAnswers, normalizeProviderPayload } from "../src/lib/mca/intake/providers"
import type { IntegrationRecord } from "../src/lib/mca/intake/repository"

const integration = { formId: "form", locationId: "location", templateId: "template", mapping: {}, approvalState: "approved", contractKey: "zoho_forms_json_drive_v1" } as IntegrationRecord

test("answer snapshots preserve custom, nested, list and website answers without transport secrets", () => {
  const answers = captureIntakeAnswers({ legalName: "Merchant", website: "https://merchant.example/about", custom: { choices: ["one", "two"], apiKey: "secret" }, mca_rep: "routing", q42_mcaInvite: "invite", statement: "https://files.example/bank.pdf?token=secret" })
  assert.deepEqual(answers.map(a => a.key), ["legalName", "website", "custom", "statement"])
  assert.equal(answers[1].value, "https://merchant.example/about")
  assert.deepEqual(JSON.parse(answers[2].value), { choices: ["one", "two"] })
  assert.ok(!JSON.stringify(answers).includes("secret"))
})

test("all webhook form adapters retain custom answers, using provider labels and private file references", () => {
  const cases = [
    ["jotform", { formID: "form", submissionID: "event", rawRequest: { legalName: "Merchant", custom: ["yes", "no"], mca_invite: "secret" } }],
    ["custom", { formId: "form", eventId: "event", application: { legalName: "Merchant", custom: ["yes", "no"] }, attributionToken: "secret" }],
    ["zoho", { formId: "form", entryId: "event", legalName: "Merchant", custom: ["yes", "no"] }],
    ["highlevel", { locationId: "location", webhookId: "event", customFields: [{ id: "custom", name: "Custom question", value: ["yes", "no"] }] }],
    ["fillout", { formId: "form", submissionId: "event", questions: [{ id: "custom", name: "Custom question", value: ["yes", "no"] }, { id: "file", name: "Bank upload", type: "fileUpload", value: [{ id: "private-file", name: "bank.pdf", url: "https://files.example/opaque-secret" }] }], urlParameters: [{ name: "mca_rep", value: "secret" }] }],
    ["docuseal", { event_type: "submission.completed", data: { id: "event", template_id: "template", submitters: [{ values: [{ field: "custom", name: "Custom question", value: ["yes", "no"] }] }] } }],
  ] as const
  for (const [provider, payload] of cases) {
    const result = normalizeProviderPayload(provider, payload, integration)
    const answer = result.answers.find(a => a.key === "custom")!
    assert.deepEqual(JSON.parse(answer.value), ["yes", "no"], provider)
    if (["highlevel", "fillout", "docuseal"].includes(provider)) assert.equal(answer.label, "Custom question")
    assert.ok(!JSON.stringify(result.answers).includes("secret"), provider)
    if (provider === "fillout") assert.match(result.answers.find(a => a.key === "file")!.value, /attachment private-file/)
  }
})
