import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  assertEmailDnsCheckEnabled,
  evaluateEmailDns,
  formatEmailDnsReport,
  main,
  normalizeTxtAnswers,
  parseEmailDnsManifest,
  runEmailDnsCheck,
  type EmailDnsExpectedRecord,
} from "../scripts/ops/email-dns-check"

const expected: readonly EmailDnsExpectedRecord[] = [
  { type: "MX", name: "fundlane.io", values: [{ priority: 10, target: "mx1.example.test" }, { priority: 20, target: "mx2.example.test" }] },
  { type: "TXT", name: "fundlane.io", purpose: "spf", value: "v=spf1 include:mail.example.test -all" },
  { type: "TXT", name: "selector._domainkey.fundlane.io", purpose: "dkim", value: "v=DKIM1; k=rsa; p=publicfixture" },
  { type: "TXT", name: "_dmarc.fundlane.io", purpose: "dmarc", value: "v=DMARC1; p=reject; rua=mailto:dmarc@example.test" },
]

const passing = {
  mx: { "fundlane.io": [{ priority: 20, exchange: "MX2.EXAMPLE.TEST." }, { priority: 10, exchange: "mx1.example.test." }] },
  txt: {
    "fundlane.io": [["v=spf1 include:mail.", "example.test -all"]],
    "selector._domainkey.fundlane.io": [["v=DKIM1; k=rsa; ", "p=publicfixture"]],
    "_dmarc.fundlane.io": [["v=DMARC1; p=reject; rua=mailto:dmarc@example.test"]],
  },
}

test("the guard accepts only exact true and disabled CLI performs no DNS I/O", async () => {
  for (const value of [undefined, "false", "TRUE", "1"]) assert.throws(() => assertEmailDnsCheckEnabled({ MCA_EMAIL_DNS_CHECK_ENABLED: value }), /disabled/)
  assert.doesNotThrow(() => assertEmailDnsCheckEnabled({ MCA_EMAIL_DNS_CHECK_ENABLED: "true" }))
  let output = ""
  let calls = 0
  const exit = await main([], {}, { stdout: { write(value: string) { output += value; return true } }, stderr: { write(value: string) { output += value; return true } } }, {
    resolveMx: async () => { calls++; return [] },
    resolveTxt: async () => { calls++; return [] },
  })
  assert.equal(exit, 1)
  assert.equal(calls, 0)
  assert.equal(output, "Email DNS readiness check is disabled. Set MCA_EMAIL_DNS_CHECK_ENABLED=true to allow read-only public DNS lookups.\n")
})

test("TXT chunks are joined per answer, never across separate records", () => {
  assert.deepEqual(normalizeTxtAnswers([["one", "two"], ["three"]]), ["onetwo", "three"])
})

test("manifest accepts approved MX and each TXT purpose, including case and trailing dot names", () => {
  const parsed = parseEmailDnsManifest([
    { type: "MX", name: "FUNDLANE.IO.", values: [{ priority: 10, target: "mx.example.test." }] },
    ...(["spf", "dkim", "dmarc", "other"] as const).map(purpose => ({ type: "TXT", name: `selector.Fundlane.IO.`, purpose, value: "public value" })),
  ])
  assert.equal(parsed.length, 5)
})

test("manifest rejects malformed arrays, unknown fields and types, bad names, and empty values", () => {
  const mx = { type: "MX", name: "fundlane.io", values: [{ priority: 10, target: "mx.example.test" }] }
  const txt = { type: "TXT", name: "fundlane.io", purpose: "spf", value: "v=spf1 -all" }
  const invalid: [unknown, RegExp][] = [
    [{ ...mx, blocked: true }, /unknown field "blocked"/],
    [null, /must be an object/],
    [{ ...mx, type: "CNAME" }, /invalid type/],
    [{ ...mx, name: "notfundlane.io" }, /name must/],
    [{ ...mx, name: "foo..fundlane.io" }, /name must/],
    [{ ...mx, name: "foo.fundlane.io.evil" }, /name must/],
    [{ ...mx, values: [] }, /nonempty array/],
    [{ ...mx, values: [{ priority: -1, target: "mx.example.test" }] }, /priority/],
    [{ ...mx, values: [{ priority: 10, target: "bad target" }] }, /target/],
    [{ ...mx, values: [{ priority: 10, target: "mx.example.test", extra: 1 }] }, /unknown field/],
    [{ ...txt, purpose: "unknown" }, /purpose/],
    [{ ...txt, value: "  " }, /nonempty string/],
    [{ ...txt, values: [] }, /unknown field/],
    [Array.from({ length: 51 }, () => txt), /at most 50/],
  ]
  assert.throws(() => parseEmailDnsManifest({}), /nonempty array/)
  assert.throws(() => parseEmailDnsManifest([]), /nonempty array/)
  for (const [entry, error] of invalid) assert.throws(() => parseEmailDnsManifest(Array.isArray(entry) ? entry : [entry]), error)
})

test("other TXT passes with one exact answer among unrelated answers", () => {
  const record: EmailDnsExpectedRecord = { type: "TXT", name: "fundlane.io", purpose: "other", value: "verify=exact" }
  assert.equal(evaluateEmailDns([record], { mx: {}, txt: { "fundlane.io": [["unrelated"], ["verify=", "exact"]] } })[0]?.status, "pass")
  assert.equal(evaluateEmailDns([record], { mx: {}, txt: { "fundlane.io": [["verify=exact-extra"]] } })[0]?.status, "fail")
})

test("passing fixtures accept reordered, case-varied, trailing-dot MX and chunked TXT", async () => {
  const results = await runEmailDnsCheck({
    expected,
    resolveMx: async name => passing.mx[name as keyof typeof passing.mx],
    resolveTxt: async name => passing.txt[name as keyof typeof passing.txt],
  })
  assert.deepEqual(results.map(result => result.status), ["pass", "pass", "pass", "pass"])
  assert.equal(formatEmailDnsReport(results), [
    "Email DNS readiness: PASS",
    "PASS MX fundlane.io: expected record is present.",
    "PASS TXT fundlane.io: expected record is present.",
    "PASS TXT selector._domainkey.fundlane.io: expected record is present.",
    "PASS TXT _dmarc.fundlane.io: expected record is present.",
    "DNS readiness does not prove provider verification, mailbox receipt, or outbound delivery.",
    "",
  ].join("\n"))
})

test("missing MX, wrong priority, conflicting SPF, absent/wrong DKIM, and weak DMARC fail", () => {
  const variants = [
    { ...passing, mx: { "fundlane.io": [] } },
    { ...passing, mx: { "fundlane.io": [{ priority: 99, exchange: "mx1.example.test" }, { priority: 20, exchange: "mx2.example.test" }] } },
    { ...passing, txt: { ...passing.txt, "fundlane.io": [["v=spf1 include:mail.example.test -all"], ["v=spf1 ~all"]] } },
    { ...passing, txt: { ...passing.txt, "selector._domainkey.fundlane.io": [] } },
    { ...passing, txt: { ...passing.txt, "selector._domainkey.fundlane.io": [["v=DKIM1; p=wrong"]] } },
    { ...passing, txt: { ...passing.txt, "_dmarc.fundlane.io": [["v=DMARC1; p=none"]] } },
  ]
  for (const answers of variants) assert.ok(evaluateEmailDns(expected, answers).some(result => result.status === "fail"))
})

test("NXDOMAIN and timeout are converted to failed results", async () => {
  const results = await runEmailDnsCheck({
    expected: expected.slice(0, 2),
    resolveMx: async () => { throw new Error("NXDOMAIN") },
    resolveTxt: async () => { throw new Error("query timed out") },
  })
  assert.deepEqual(results.map(result => result.status), ["fail", "fail"])
  assert.match(results[0]!.reason, /NXDOMAIN/)
  assert.match(results[1]!.reason, /timeout/)
})

test("unknown provider-issued records remain blocked and output is deterministic and redaction-safe", async () => {
  const secret = "provider-secret-never-print"
  const results = await runEmailDnsCheck({
    expected: [{ type: "TXT", name: "<provider-selector>._domainkey.fundlane.io", purpose: "dkim", blocked: true }],
    resolveMx: async () => { throw new Error(secret) },
    resolveTxt: async () => { throw new Error(secret) },
  })
  const output = formatEmailDnsReport(results)
  assert.equal(output, "Email DNS readiness: BLOCKED\nBLOCKED TXT <provider-selector>._domainkey.fundlane.io: supply the value from useSend's domain setup (or the approved policy) via --expected.\nDNS readiness does not prove provider verification, mailbox receipt, or outbound delivery.\n")
  assert.equal(output.includes(secret), false)
})

test("enabled CLI reports blocked manifest deterministically with nonzero status", async () => {
  let stdout = "", stderr = "", calls = 0
  const exit = await main([], { MCA_EMAIL_DNS_CHECK_ENABLED: "true", MCA_USESEND_API_KEY: "must-not-print" }, {
    stdout: { write(value: string) { stdout += value } },
    stderr: { write(value: string) { stderr += value } },
  }, {
    resolveMx: async () => { calls++; return [] },
    resolveTxt: async () => { calls++; return [] },
  })
  assert.equal(exit, 1)
  assert.equal(calls, 0)
  assert.equal(stderr, "")
  assert.match(stdout, /^Email DNS readiness: BLOCKED\n/)
  assert.equal(stdout.includes("must-not-print"), false)
})

test("CLI loads a complete manifest and exits zero when injected DNS answers pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "email-dns-"))
  try {
    const path = join(directory, "expected.json")
    await writeFile(path, JSON.stringify(expected))
    let stdout = "", stderr = ""
    const exit = await main([`--expected=${path}`], { MCA_EMAIL_DNS_CHECK_ENABLED: "true" }, {
      stdout: { write(value: string) { stdout += value } },
      stderr: { write(value: string) { stderr += value } },
    }, {
      resolveMx: async name => passing.mx[name as keyof typeof passing.mx],
      resolveTxt: async name => passing.txt[name as keyof typeof passing.txt],
    })
    assert.equal(exit, 0)
    assert.match(stdout, /^Email DNS readiness: PASS\n/)
    assert.equal(stderr, "")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("CLI rejects a manifest combined with DKIM flags before DNS I/O", async () => {
  let output = "", calls = 0
  const exit = await main(["--expected=missing.json", "--dkim-selector=selector"], { MCA_EMAIL_DNS_CHECK_ENABLED: "true" }, {
    stdout: { write(value: string) { output += value } },
    stderr: { write(value: string) { output += value } },
  }, {
    resolveMx: async () => { calls++; return [] },
    resolveTxt: async () => { calls++; return [] },
  })
  assert.equal(exit, 1)
  assert.equal(calls, 0)
  assert.match(output, /--expected cannot be combined/)
})
