import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// Customer-facing billing, pricing, onboarding and marketing copy. Accounting screens that
// explicitly say no bank transfer is initiated are internal ledger notices, not payment claims.
const sourceRoot = join(import.meta.dirname, "../src")
const copyPaths = [
  "app/(dashboard)/pricing",
  "app/(auth)/onboarding",
  "app/(auth)/sign-up",
  "app/features",
  "app/help",
  "app/changelog",
  "app/marketing",
  "app/page.tsx",
  "components/marketing",
  "components/mca/billing-panel.tsx",
  "components/mca/seat-selector.tsx",
  "lib/marketing",
  "lib/mca/email.ts",
]
const falseClaim = /\bpay\s*pal\b|\bbank[\s-]+transfers?\b|\bwire[\s-]+transfers?\b|\bsave\s+\d+\s*%|\d+\s*%\s+(?:off|discount|savings?)\b/i

function files(path: string): string[] {
  const fullPath = join(sourceRoot, path)
  if (!statSync(fullPath, { throwIfNoEntry: false })) return []
  if (!statSync(fullPath).isDirectory()) return [path]
  return readdirSync(fullPath, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(path, entry.name)) : /\.(?:json|tsx?|jsx?|md)$/.test(entry.name) ? [join(path, entry.name)] : [])
}

test("customer copy does not claim PayPal, bank transfer or annual discount support", () => {
  const scanned = copyPaths.flatMap(files)
  assert.ok(scanned.includes(join("app/(dashboard)/pricing", "data/faqs.json")))
  for (const path of scanned) assert.doesNotMatch(readFileSync(join(sourceRoot, path), "utf8"), falseClaim, path)
})

test("pricing FAQ payment answers describe only card payments through Stripe", () => {
  const faq = JSON.parse(readFileSync(join(sourceRoot, "app/(dashboard)/pricing/data/faqs.json"), "utf8")) as { question: string; answer: string }[]
  const payment = faq.find(item => /payment methods/i.test(item.question))?.answer ?? ""
  assert.match(payment, /card/i)
  assert.match(payment, /Stripe/)
  const annual = faq.find(item => /annual/i.test(item.question))?.answer ?? ""
  assert.match(annual, /monthly/i)
})
