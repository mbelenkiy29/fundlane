import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { LegalDraft } from "../src/components/marketing/legal-draft"
import { unauthenticatedPageGate } from "../src/lib/mca/app-paths"
import { privacySections, termsSections } from "../src/lib/marketing/legal-drafts"

test("legal pages are public and render the shared draft content", () => {
  const root = resolve(import.meta.dirname, "../src")
  for (const [path, sections] of [["/terms", termsSections], ["/privacy", privacySections]] as const) {
    assert.deepEqual(unauthenticatedPageGate(path), { action: "allow", status: 200 })
    const page = readFileSync(resolve(root, `app${path}/page.tsx`), "utf8")
    assert.match(page, /<MarketingShell/)
    assert.match(page, /<LegalDraft/)
    const main = LegalDraft({ title: path === "/terms" ? "Terms of Service" : "Privacy Policy", sections })
    assert.equal(main.type, "main")
    const copy = JSON.stringify(main)
    assert.match(copy, /DRAFT — pending legal review\. Not yet in effect\./)
    assert.match(copy, /Last updated:/)
    assert.match(copy, /\[date pending legal review\]/)
    assert.match(copy, /\[Company legal name\]/)
    assert.match(copy, /\[contact email\]/)
  }
})

test("footer and sign-up agreement link to both draft documents", () => {
  const root = resolve(import.meta.dirname, "../src")
  const footer = readFileSync(resolve(root, "components/marketing/shell.tsx"), "utf8")
  const signup = readFileSync(resolve(root, "app/(auth)/sign-up/components/signup-form-1.tsx"), "utf8")
  for (const path of ["/terms", "/privacy"]) {
    assert.match(footer, new RegExp(`href="${path}"`))
    assert.match(signup, new RegExp(`href="${path}"`))
  }
  assert.match(signup, /name="terms" required/)
  assert.match(signup, /target="_blank" rel="noopener noreferrer"/)
})
