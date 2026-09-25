import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { invitationSchema } from "../src/lib/mca/schemas"
import { invitationInput } from "../src/lib/mca/applications/contracts"
import { validateApplicationInvitation, validateTeamInvitation } from "../src/lib/mca/invitations-validation"
import { validateFunderProfile, validateGroupName } from "../src/lib/mca/funders/validation"

test("funder create validation requires a legal name and surfaces field errors", () => {
  const empty = validateFunderProfile({}, { requireLegalName: true })
  assert.deepEqual(empty.legalName, ["Enter the funder legal name."])

  const invalid = validateFunderProfile({
    legalName: "Harbor Capital",
    website: "not a url",
    contacts: [{ email: "bad-email" }],
    routes: [{ kind: "email", label: "", destination: "" }],
  }, { requireLegalName: true })
  assert.equal(invalid.website?.[0], "Enter a valid website URL.")
  assert.equal(invalid["contacts.0.email"]?.[0], "Enter a valid email address.")
  assert.equal(invalid["routes.0.label"]?.[0], "Enter a route label.")
  assert.equal(invalid["routes.0.destination"]?.[0], "Enter a route destination.")

  const valid = validateFunderProfile({
    legalName: "Harbor Capital",
    website: "https://harbor.example",
    contacts: [{ name: "Ada", email: "ada@harbor.example" }],
    routes: [{ kind: "email", label: "Underwriting", destination: "uw@harbor.example" }],
  }, { requireLegalName: true })
  assert.deepEqual(valid, {})
  assert.deepEqual(validateGroupName(""), { name: ["Enter a group name."] })
})

test("team and application invitation validation matches server messages", () => {
  const team = validateTeamInvitation({ name: "", email: "not-an-email", phone: "12" })
  assert.equal(team.name?.[0], "Enter the employee's full name.")
  assert.equal(team.email?.[0], "Enter a valid email address.")
  assert.equal(team.phone?.[0], "Enter a phone number with 7 to 32 characters.")

  const teamOk = validateTeamInvitation({ name: "Ada Lovelace", email: "ada@example.test", role: "rep" })
  assert.deepEqual(teamOk, {})

  const parsed = invitationSchema.safeParse({ name: "", email: "bad", role: "rep" })
  assert.equal(parsed.success, false)
  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue) => issue.message)
    assert.ok(messages.includes("Enter the employee's full name."))
    assert.ok(messages.includes("Enter a valid email address."))
  }

  const client = validateApplicationInvitation({ clientName: "", email: "nope" })
  assert.equal(client.clientName?.[0], "Enter the business name.")
  assert.equal(client.email?.[0], "Enter a valid email address.")
  const clientSchema = invitationInput.safeParse({ clientName: "", email: "nope", integrationId: "form", requestKey: "not-a-uuid" })
  assert.equal(clientSchema.success, false)
})

test("create funder and invitation forms render field-level errors", () => {
  const funder = readFileSync(new URL("../src/components/mca/funders/funder-directory-panel.tsx", import.meta.url), "utf8")
  assert.match(funder, /validateFunderProfile/)
  assert.match(funder, /noValidate/)
  assert.match(funder, /aria-invalid/)
  assert.match(funder, /Review the highlighted fields/)

  const team = readFileSync(new URL("../src/components/mca/team-panel.tsx", import.meta.url), "utf8")
  assert.match(team, /validateTeamInvitation/)
  assert.match(team, /fieldErrors/)
  assert.match(team, /noValidate/)
  assert.match(team, /Review the highlighted fields/)

  const applications = readFileSync(new URL("../src/components/mca/applications/applications-workspace.tsx", import.meta.url), "utf8")
  assert.match(applications, /validateApplicationInvitation/)
  assert.match(applications, /clientName-error/)
  assert.match(applications, /clientEmail-error/)
})
