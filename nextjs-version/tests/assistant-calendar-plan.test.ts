import test from "node:test"
import assert from "node:assert/strict"
import {
  allocateCalendarSlots,
  calendarPlanMarker,
  candidatesFromQueue,
  suggestionForReason,
} from "../src/lib/mca/assistant/calendar-plan"

test("maps missing documents and unsold offers to follow-ups, and submit to a submission task", () => {
  assert.deepEqual(suggestionForReason({ dealId: "d1", legalName: "Acme Deli", reason: "missing_doc" }), {
    kind: "followup",
    title: "Collect missing docs — Acme Deli",
    marker: "assistant-plan:v1:d1:missing_doc",
  })
  assert.deepEqual(suggestionForReason({ dealId: "d1", legalName: "Acme Deli", reason: "pitch" }), {
    kind: "followup",
    title: "Pitch offer — Acme Deli",
    marker: "assistant-plan:v1:d1:pitch",
  })
  assert.deepEqual(suggestionForReason({ dealId: "d1", legalName: "Acme Deli", reason: "merchant_follow_up" }), {
    kind: "followup",
    title: "Follow up merchant on offer — Acme Deli",
    marker: "assistant-plan:v1:d1:merchant_follow_up",
  })
  assert.deepEqual(suggestionForReason({ dealId: "d1", legalName: "Acme Deli", reason: "submit" }), {
    kind: "submission_task",
    title: "Submit to funders — Acme Deli",
    marker: "assistant-plan:v1:d1:submit",
  })
  assert.equal(calendarPlanMarker("d1", "missing_doc"), "assistant-plan:v1:d1:missing_doc")
})

test("schedules next weekday 09:00 local, skips duplicates, collisions, and caps at ten", () => {
  const fridayEvening = new Date("2026-10-02T22:00:00.000Z")
  const items = [
    { dealId: "a", legalName: "Alpha", reason: "missing_doc" as const },
    { dealId: "b", legalName: "Beta", reason: "pitch" as const },
    { dealId: "c", legalName: "Gamma", reason: "submit" as const },
    { dealId: "d", legalName: "Delta", reason: "missing_doc" as const },
  ]
  const first = allocateCalendarSlots({
    items,
    timezone: "America/New_York",
    now: fridayEvening,
    busy: [{ start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T13:30:00.000Z" }],
    existingMarkers: new Set(["assistant-plan:v1:d:missing_doc"]),
    limit: 10,
  })
  assert.equal(first.length, 3)
  assert.equal(first[0].start, "2026-10-05T14:00:00.000Z")
  assert.equal(first[0].end, "2026-10-05T14:30:00.000Z")
  assert.equal(first[0].title, "Collect missing docs — Alpha")
  assert.match(first[0].notes, /assistant-plan:v1:a:missing_doc/)
  assert.equal(first[1].start, "2026-10-05T15:00:00.000Z")
  assert.equal(first[2].kind, "submission_task")

  const crowded = allocateCalendarSlots({
    items: Array.from({ length: 12 }, (_, i) => ({
      dealId: `deal-${i}`,
      legalName: `Merchant ${i}`,
      reason: "missing_doc" as const,
    })),
    timezone: "America/New_York",
    now: fridayEvening,
    busy: [],
    existingMarkers: new Set(),
  })
  assert.equal(crowded.length, 10)
})

test("flattens needs-action reasons and can scope to one deal", () => {
  const items = [
    {
      dealId: "a",
      legalName: "Alpha",
      reasons: [{ code: "missing_doc" as const }, { code: "pitch" as const }],
    },
    {
      dealId: "b",
      legalName: "Beta",
      reasons: [{ code: "submit" as const }],
    },
  ]
  const all = candidatesFromQueue(items)
  assert.equal(all.length, 3)
  assert.deepEqual(all.map((item) => item.reason), ["missing_doc", "pitch", "submit"])
  const scoped = candidatesFromQueue(items, "b")
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].dealId, "b")
})
