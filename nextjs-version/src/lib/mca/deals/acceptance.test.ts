import test from "node:test"
import type { DealActor, DealAssignment, DealRecord } from "./schema"
import assert from "node:assert/strict"

import { canActorAccessDeal, normalizePrimaryAssignments, permittedAssignmentIds } from "./access-policy"
import { inclusiveUtcDateBounds, reconcilePipelineCounts } from "./filters"
import { allowedTransitions, canTransition } from "./pipeline"
import {
  describeMissingRequiredFields,
  missingRequiredFieldAnchor,
  missingRequiredFieldLabel,
  submissionMissingFields,
  validateDealInput,
} from "./validation"

const actor = (overrides: Partial<DealActor> = {}): DealActor => ({
  workspaceId: "workspace-a", userId: "user-manager", membershipId: "manager-1", role: "manager",
  managedMembershipIds: ["rep-a"], activeMembershipIds: ["manager-1", "rep-a", "rep-b"], source: "user", correlationId: "correlation-1",
  ...overrides,
})

const record = (assignments: DealAssignment[]): Pick<DealRecord, "workspaceId" | "assignments"> => ({ workspaceId: "workspace-a", assignments })

test("SEN-32: partial application reports submission-required fields without rejecting the draft", () => {
  const partial = { legalName: "Harbor Coffee LLC", owners: [], address: {} }
  const missing = submissionMissingFields(partial)
  assert.equal(validateDealInput(partial).legalName, undefined)
  assert.ok(missing.includes("entityType"))
  assert.ok(missing.includes("owners"))
  assert.ok(missing.includes("requestedAmount"))
})

test("SEN-32: validation returns actionable owner and underwriting field errors", () => {
  const errors = validateDealInput({
    ein: "123", naicsCode: "44", ficoScore: 900,
    owners: [{ firstName: "Ari", ownershipPercent: 110, identityLast4: "12" }],
  })
  assert.deepEqual(Object.keys(errors).sort(), ["ein", "ficoScore", "naicsCode", "owners", "owners.0.identityLast4", "owners.0.ownershipPercent"].sort())
})

test("optional requestedTermMonths accepts 1–60 integers and rejects out-of-range values", () => {
  assert.equal(validateDealInput({ requestedTermMonths: 1 }).requestedTermMonths, undefined)
  assert.equal(validateDealInput({ requestedTermMonths: 60 }).requestedTermMonths, undefined)
  assert.equal(validateDealInput({ requestedTermMonths: 12 }).requestedTermMonths, undefined)
  assert.ok(validateDealInput({ requestedTermMonths: 0 }).requestedTermMonths?.length)
  assert.ok(validateDealInput({ requestedTermMonths: 61 }).requestedTermMonths?.length)
  assert.ok(validateDealInput({ requestedTermMonths: 12.5 }).requestedTermMonths?.length)
  assert.ok(validateDealInput({ requestedTermMonths: -3 }).requestedTermMonths?.length)
})

test("missing required fields expose human names and form anchors from the same keys as the count", () => {
  const missing = submissionMissingFields({ legalName: "Harbor Coffee LLC", owners: [], address: {} })
  assert.ok(missing.length > 0)
  const described = describeMissingRequiredFields(missing)
  assert.equal(described.length, missing.length)
  assert.deepEqual(described.map((item) => item.key), missing)
  for (const item of described) {
    assert.notEqual(item.label, item.key)
    assert.match(item.anchor, /^deal-field-/)
  }
  assert.equal(missingRequiredFieldLabel("legalName"), "Legal name")
  assert.equal(missingRequiredFieldLabel("address.line1"), "Street address")
  assert.equal(missingRequiredFieldLabel("owners.0.firstName"), "Owner 1 first name")
  assert.equal(missingRequiredFieldAnchor("address.postalCode"), "deal-field-postalCode")
  assert.equal(missingRequiredFieldAnchor("owners.1.ownershipPercent"), "deal-field-owners-1-ownershipPercent")
})

test("optional requestedTermMonths is not a submission-required field", () => {
  const missing = submissionMissingFields({
    legalName: "Harbor Coffee LLC",
    entityType: "llc",
    address: { line1: "1 Main", city: "Brooklyn", state: "NY", postalCode: "11201" },
    contactPhone: "555-0100",
    startDate: "2020-01-01",
    industry: "restaurants",
    monthlyRevenue: 20_000,
    requestedAmount: 50_000,
    fundingPurpose: "working capital",
    owners: [{ id: "o1", firstName: "Ari", lastName: "Lee", ownershipPercent: 100 }],
  })
  assert.equal(missing.includes("requestedTermMonths"), false)
  assert.deepEqual(missing, [])
})

test("SEN-28/SEN-32: manager visibility follows originator hierarchy and excludes managed closer-only deals", () => {
  const manager = actor()
  assert.equal(canActorAccessDeal(manager, record([{ membershipId: "rep-a", kind: "originator", id: "a", isPrimary: true, assignedAt: "now", assignedByUserId: null }])), true)
  assert.equal(canActorAccessDeal(manager, record([{ membershipId: "rep-a", kind: "closer", id: "a", isPrimary: true, assignedAt: "now", assignedByUserId: null }])), false)
  assert.equal(canActorAccessDeal(manager, record([{ membershipId: "rep-b", kind: "originator", id: "a", isPrimary: true, assignedAt: "now", assignedByUserId: null }])), false)
  assert.equal(canActorAccessDeal(manager, record([{ membershipId: "manager-1", kind: "closer", id: "a", isPrimary: true, assignedAt: "now", assignedByUserId: null }])), true)
})

test("SEN-28: reps can access their own originator and closer assignments only", () => {
  const rep = actor({ role: "rep", membershipId: "rep-a", managedMembershipIds: [] })
  assert.equal(canActorAccessDeal(rep, record([{ membershipId: "rep-a", kind: "originator", id: "a", isPrimary: true, assignedAt: "now", assignedByUserId: null }])), true)
  assert.equal(canActorAccessDeal(rep, record([{ membershipId: "rep-a", kind: "closer", id: "b", isPrimary: true, assignedAt: "now", assignedByUserId: null }])), true)
  assert.equal(canActorAccessDeal(rep, record([{ membershipId: "rep-b", kind: "originator", id: "c", isPrimary: true, assignedAt: "now", assignedByUserId: null }])), false)
})

test("SEN-32: assignment targets cannot exceed a rep or manager's active hierarchy", () => {
  assert.deepEqual([...permittedAssignmentIds(actor({ role: "rep", membershipId: "rep-a", managedMembershipIds: [] }))], ["rep-a"])
  assert.deepEqual([...permittedAssignmentIds(actor())].sort(), ["manager-1", "rep-a"])
  assert.equal(permittedAssignmentIds(actor()).has("rep-b"), false)
})

test("SEN-32: multiple originators and closers receive one primary marker per assignment kind", () => {
  const normalized = normalizePrimaryAssignments([
    { id: "1", membershipId: "rep-a", kind: "originator", isPrimary: true, assignedAt: "now", assignedByUserId: "u" },
    { id: "2", membershipId: "rep-b", kind: "originator", isPrimary: true, assignedAt: "now", assignedByUserId: "u" },
    { id: "3", membershipId: "rep-b", kind: "closer", isPrimary: false, assignedAt: "now", assignedByUserId: "u" },
  ])
  assert.deepEqual(normalized.filter((item) => item.isPrimary).map((item) => item.id), ["1", "3"])
})

test("SEN-35: lifecycle includes recovery from closed, repricing, missed payments, and default", () => {
  assert.equal(canTransition("offer", "repricing"), true)
  assert.equal(canTransition("missed_payments", "funded"), true)
  assert.equal(canTransition("default", "funded"), true)
  assert.equal(canTransition("closed", "new_application"), true)
  assert.equal(canTransition("lead", "funded"), false)
  assert.ok(allowedTransitions("funded").includes("renewed"))
})

test("SEN-35: the inclusive date filter uses stable UTC day boundaries", () => {
  assert.deepEqual(inclusiveUtcDateBounds("2026-09-01", "2026-09-07"), {
    from: "2026-09-01T00:00:00.000Z",
    toExclusive: "2026-09-08T00:00:00.000Z",
  })
})

test("SEN-35: table total and Kanban counts reconcile from the identical filtered set", () => {
  const filtered = [{ status: "lead" }, { status: "lead" }, { status: "offer" }, { status: "funded" }] as const
  const counts = reconcilePipelineCounts(filtered)
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), filtered.length)
  assert.deepEqual(counts, { lead: 2, offer: 1, funded: 1 })
})
