import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { invitationSchema } from "../src/lib/mca/schemas"
import { invitationInput } from "../src/lib/mca/applications/contracts"
import { normalizeTeamInvitationInput, validateApplicationInvitation, validateTeamInvitation } from "../src/lib/mca/invitations-validation"
import { firstFieldError, remapIndexedFieldErrors, validateFunderProfile, validateGroupName } from "../src/lib/mca/funders/validation"
import { isTeamProfitReportEmpty } from "../src/lib/mca/reports/team-profit-empty"

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

  const tooManyDomains = validateFunderProfile({
    legalName: "Harbor Capital",
    domains: Array.from({ length: 31 }, (_, index) => `funder-${index}.example`),
  }, { requireLegalName: true })
  assert.equal(tooManyDomains.domains?.[0], "Use at most 30 values.")
  assert.equal(firstFieldError(tooManyDomains, "domains"), "Use at most 30 values.")
})

test("team and application invitation validation matches server messages", () => {
  const team = validateTeamInvitation({ name: "", email: "not-an-email", phone: "12" })
  assert.equal(team.name?.[0], "Enter the employee's full name.")
  assert.equal(team.email?.[0], "Enter a valid email address.")
  assert.equal(team.phone?.[0], "Enter a phone number with 7 to 32 characters.")

  const teamOk = validateTeamInvitation({ name: "Ada Lovelace", email: "ada@example.test", role: "rep" })
  assert.deepEqual(teamOk, {})

  const padded = validateTeamInvitation({ name: " Ada Lovelace ", email: " ada@example.test ", role: "rep" })
  assert.deepEqual(padded, {})
  assert.deepEqual(
    normalizeTeamInvitationInput({
      name: " Ada Lovelace ",
      email: " ada@example.test ",
      phone: " 555-0100 ",
      role: "rep",
      managerMembershipId: "",
      senderAssociation: " Desk ",
    }),
    {
      name: "Ada Lovelace",
      email: "ada@example.test",
      phone: "555-0100",
      role: "rep",
      managerMembershipId: undefined,
      senderAssociation: "Desk",
    },
  )

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
  assert.match(funder, /aria-describedby/)
  assert.match(funder, /firstFieldError/)
  assert.match(funder, /remapIndexedFieldErrors/)
  assert.match(funder, /FUNDER_FIELD_LIMITS\.maxContacts/)
  assert.match(funder, /FUNDER_FIELD_LIMITS\.maxRoutes/)
  assert.match(funder, /fieldErrors\.contacts/)
  assert.match(funder, /fieldErrors\.routes/)
  assert.match(funder, /Review the highlighted fields/)

  const team = readFileSync(new URL("../src/components/mca/team-panel.tsx", import.meta.url), "utf8")
  assert.match(team, /validateTeamInvitation/)
  assert.match(team, /normalizeTeamInvitationInput/)
  assert.match(team, /fieldErrors/)
  assert.match(team, /noValidate/)
  assert.match(team, /Review the highlighted fields/)

  const applications = readFileSync(new URL("../src/components/mca/applications/applications-workspace.tsx", import.meta.url), "utf8")
  assert.match(applications, /validateApplicationInvitation/)
  assert.match(applications, /clientName-error/)
  assert.match(applications, /clientEmail-error/)
})

test("funder row errors remap after an earlier row is removed", () => {
  const remapped = remapIndexedFieldErrors({
    legalName: ["Enter the funder legal name."],
    contacts: ["Use at most 50 contacts."],
    "contacts.0.email": ["stale first row"],
    "contacts.1.email": ["Enter a valid email address."],
    "contacts.1.name": ["Use at most 120 characters."],
    "routes.0.label": ["Enter a route label."],
  }, "contacts", 0, 50, 50)
  assert.deepEqual(remapped, {
    legalName: ["Enter the funder legal name."],
    "contacts.0.email": ["Enter a valid email address."],
    "contacts.0.name": ["Use at most 120 characters."],
    "routes.0.label": ["Enter a route label."],
  })

  const stillOver = remapIndexedFieldErrors({
    contacts: ["Use at most 50 contacts."],
    "contacts.2.email": ["Enter a valid email address."],
  }, "contacts", 0, 51, 50)
  assert.deepEqual(stillOver, {
    contacts: ["Use at most 50 contacts."],
    "contacts.1.email": ["Enter a valid email address."],
  })
})

test("team profit empty state keeps independently calculated operating costs visible", () => {
  const emptyStages = {
    created: { dealCount: 0 },
    submitted: { dealCount: 0 },
    approved: { dealCount: 0 },
    funded: { dealCount: 0 },
  }
  assert.equal(isTeamProfitReportEmpty({
    company: { stages: emptyStages, distributions: { count: 0 } },
    evidence: { length: 0 },
    otherOperatingCosts: { knownCents: 0, unknownCount: 0 },
  }), true)
  assert.equal(isTeamProfitReportEmpty({
    company: { stages: emptyStages, distributions: { count: 0 } },
    evidence: { length: 0 },
    otherOperatingCosts: { knownCents: 50_000, unknownCount: 0 },
  }), false)
  assert.equal(isTeamProfitReportEmpty({
    company: { stages: emptyStages, distributions: { count: 0 } },
    evidence: { length: 0 },
    otherOperatingCosts: { knownCents: 0, unknownCount: 1 },
  }), false)
})
