import assert from "node:assert/strict"
import { test } from "node:test"
import { chatkitDealEntity, chatkitDealHref } from "../src/lib/mca/assistant/chatkit-entities"
import {
  CHATKIT_DISCLAIMER,
  CHATKIT_START_PROMPTS,
  chatkitUiOptions,
  threadFromSearch,
  threadHref,
} from "../src/lib/mca/assistant/chatkit-ui"

test("page ChatKit chrome enables the header and uses normal density", () => {
  const options = chatkitUiOptions({
    surface: "page",
    colorScheme: "light",
    accent: "oklch(0.42 0.16 155)",
    background: "oklch(1 0 0)",
    foreground: "oklch(0.145 0 0)",
  })
  assert.equal(options.header?.enabled, true)
  assert.equal(options.theme.density, "normal")
  assert.equal(options.theme.radius, "round")
  assert.equal(options.thread?.autoScroll, true)
  assert.equal(options.history?.enabled, true)
  assert.equal(options.history?.showDelete, true)
  assert.equal(options.history?.showRename, true)
  assert.equal(options.composer?.placeholder, "Ask about your deals…")
  assert.equal(options.composer?.attachments?.enabled, false)
  assert.equal(options.disclaimer?.text, CHATKIT_DISCLAIMER)
  assert.deepEqual(options.startScreen?.prompts, CHATKIT_START_PROMPTS)
  assert.equal(options.startScreen?.greeting, "What would you like to know?")
  assert.equal(options.frameTitle, "Fundlane assistant")
  assert.equal(options.theme.color?.accent?.primary, "oklch(0.42 0.16 155)")
})

test("drawer ChatKit chrome hides the header and uses compact density", () => {
  const options = chatkitUiOptions({
    surface: "drawer",
    colorScheme: "dark",
    accent: "oklch(0.72 0.16 155)",
    background: "oklch(0.145 0 0)",
    foreground: "oklch(0.985 0 0)",
  })
  assert.equal(options.header?.enabled, false)
  assert.equal(options.theme.density, "compact")
  assert.equal(options.theme.colorScheme, "dark")
  assert.deepEqual(options.startScreen?.prompts, CHATKIT_START_PROMPTS)
})

test("deal entities prefer legal name and keep the deal id", () => {
  assert.deepEqual(chatkitDealEntity({ id: "deal_1", legalName: "Harbor Bakery", displayId: "MCA-1" }), {
    id: "deal_1",
    title: "Harbor Bakery",
    group: "Deals",
    icon: "suitcase",
    interactive: true,
    data: { href: "/deals?deal=deal_1" },
  })
  assert.equal(chatkitDealEntity({ id: "deal_2", legalName: "  ", displayId: "MCA-2" }).title, "MCA-2")
  assert.equal(chatkitDealEntity({ id: "deal_3", legalName: "", displayId: "" }).title, "deal_3")
  assert.equal(chatkitDealHref(chatkitDealEntity({ id: "deal_1", legalName: "Harbor Bakery", displayId: "MCA-1" })), "/deals?deal=deal_1")
})

test("thread query helpers round-trip a ChatKit thread id", () => {
  assert.equal(threadFromSearch("?thread=thr_abc"), "thr_abc")
  assert.equal(threadFromSearch("conversation=old"), null)
  assert.equal(threadFromSearch("?thread="), null)
  assert.equal(threadHref("/assistant", "thr_abc"), "/assistant?thread=thr_abc")
  assert.equal(threadHref("/assistant", null), "/assistant")
})
