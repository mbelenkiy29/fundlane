import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { FUNDLANE_MARK_CUTOUT_PATH, FUNDLANE_MARK_PATH } from "../src/components/logo"

test("Fundlane mark cuts the F out of currentColor so light and dark chrome stay readable", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/components/logo.tsx"), "utf8")
  assert.match(FUNDLANE_MARK_CUTOUT_PATH, /^M0 0h32v32H0z /)
  assert.ok(FUNDLANE_MARK_CUTOUT_PATH.includes(FUNDLANE_MARK_PATH))
  assert.match(source, /fillRule="evenodd"/)
  assert.match(source, /fill="currentColor"/)
  assert.match(source, /FUNDLANE_MARK_CUTOUT_PATH/)
  assert.doesNotMatch(source, /fill="#ffffff"/)
})
