import test from "node:test"
import assert from "node:assert/strict"
import { DemoFallback } from "../src/components/marketing/demo-fallback"

test("unavailable demo form offers the configured contact", () => {
  const markup = JSON.stringify(DemoFallback({ supportEmail: "support@example.test" }))
  assert.match(markup, /mailto:support@example\.test/)
  assert.match(markup, /Demo requests are temporarily unavailable/)
})

test("unconfigured fallback contains no invented contact", () => {
  const markup = JSON.stringify(DemoFallback({ supportEmail: null }))
  assert.match(markup, /Please check back soon/)
  assert.doesNotMatch(markup, /mailto:/)
})
