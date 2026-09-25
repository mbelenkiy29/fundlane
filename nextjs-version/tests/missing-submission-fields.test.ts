import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import {
  describeMissingRequiredFields,
  focusMissingRequiredField,
  missingRequiredFieldAnchor,
} from "../src/lib/mca/deals/validation"

function renderClient(script: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test("DealForm renders an id for every live missing-field anchor, including owner rows", () => {
  const html = renderClient(`
    const React = require("react");
    const { renderToStaticMarkup } = require("react-dom/server");
    const { DealForm, draftMissingRequiredFields, emptyDraft } = require("./src/components/mca/deals/deal-form.tsx");
    const form = { ...emptyDraft(), owners: [{ firstName: "", lastName: "" }] };
    const missing = draftMissingRequiredFields(form);
    const markup = renderToStaticMarkup(React.createElement(DealForm, { form, setForm: () => {}, fieldErrors: {} }));
    console.log(JSON.stringify({ missing, html: markup }));
  `)
  const rendered = JSON.parse(html) as { missing: string[]; html: string }
  assert.ok(rendered.missing.includes("owners.0.firstName"))
  for (const field of rendered.missing) {
    assert.match(rendered.html, new RegExp(`id="${missingRequiredFieldAnchor(field)}"`))
  }
})

test("removing an owner updates the live missing list and the rendered owners section", () => {
  const payload = renderClient(`
    const React = require("react");
    const { renderToStaticMarkup } = require("react-dom/server");
    const { DealForm, draftMissingRequiredFields, emptyDraft } = require("./src/components/mca/deals/deal-form.tsx");
    const withOwner = { ...emptyDraft(), owners: [{ firstName: "", lastName: "" }] };
    const withoutOwner = { ...withOwner, owners: [] };
    console.log(JSON.stringify({
      withOwner: draftMissingRequiredFields(withOwner),
      withoutOwner: draftMissingRequiredFields(withoutOwner),
      html: renderToStaticMarkup(React.createElement(DealForm, { form: withoutOwner, setForm: () => {}, fieldErrors: {} })),
    }));
  `)
  const { withOwner, withoutOwner, html } = JSON.parse(payload) as { withOwner: string[]; withoutOwner: string[]; html: string }
  assert.ok(withOwner.includes("owners.0.firstName"))
  assert.ok(withoutOwner.includes("owners"))
  assert.equal(withoutOwner.some((field) => field.startsWith("owners.")), false)
  assert.match(html, /id="deal-field-owners"/)
  assert.doesNotMatch(html, /id="deal-field-owners-0-firstName"/)
})

test("missing-field buttons use human names and focusing a listed field targets its rendered control", () => {
  const payload = renderClient(`
    const React = require("react");
    const { renderToStaticMarkup } = require("react-dom/server");
    const { DealForm, draftMissingRequiredFields, emptyDraft } = require("./src/components/mca/deals/deal-form.tsx");
    const { MissingSubmissionFields } = require("./src/components/mca/deals/missing-submission-fields.tsx");
    const form = { ...emptyDraft(), owners: [{ firstName: "", lastName: "" }] };
    const missing = draftMissingRequiredFields(form);
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
      React.createElement(MissingSubmissionFields, { fields: missing, onSelect: () => {} }),
      React.createElement(DealForm, { form, setForm: () => {}, fieldErrors: {} }),
    ));
    console.log(JSON.stringify({ missing, html }));
  `)
  const { missing, html } = JSON.parse(payload) as { missing: string[]; html: string }
  const described = describeMissingRequiredFields(missing)
  for (const item of described) {
    assert.match(html, new RegExp(`>${item.label}<`))
    assert.match(html, new RegExp(`id="${item.anchor}"`))
  }
  assert.match(html, />Legal name</)
  assert.match(html, />Owner 1 first name</)

  const ids = new Set([...html.matchAll(/id="(deal-field-[^"]+)"/g)].map((match) => match[1]))
  let focused = ""
  const lookup = {
    getElementById(id: string) {
      if (!ids.has(id)) return null
      return {
        matches: () => false,
        querySelector: () => ({ focus() { focused = id } }),
        scrollIntoView() {},
      }
    },
  }
  const result = focusMissingRequiredField("legalName", lookup)
  assert.equal(result.focused, true)
  assert.equal(result.anchor, "deal-field-legalName")
  assert.equal(focused, "deal-field-legalName")
})
