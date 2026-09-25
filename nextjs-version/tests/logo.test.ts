import test from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { FUNDLANE_MARK_PATH, Logo } from "../src/components/logo"

test("Fundlane mark cuts the F out of currentColor so light and dark chrome stay readable", () => {
  const markup = renderToStaticMarkup(createElement(Logo, { size: 24 }))
  assert.match(markup, /mask=/)
  assert.match(markup, /<mask /)
  assert.match(markup, new RegExp(`<path d="${FUNDLANE_MARK_PATH}" fill="#000000"`))
  assert.match(markup, /fill="currentColor"[^>]*mask=/)
  assert.doesNotMatch(markup, /<path[^>]*fill="#ffffff"/)
  assert.equal((markup.match(/<rect /g) ?? []).length, 2)
})
