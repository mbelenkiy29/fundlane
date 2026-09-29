import { resolveMx, resolveTxt } from "node:dns/promises"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

export type EmailDnsExpectedRecord =
  | { type: "MX"; name: string; values: readonly { priority: number; target: string }[]; blocked?: false }
  | { type: "TXT"; name: string; purpose: "spf" | "dkim" | "dmarc" | "other"; value: string; blocked?: false }
  | { type: "MX" | "TXT"; name: string; purpose?: "spf" | "dkim" | "dmarc" | "other"; blocked: true }

export interface EmailDnsAnswers { mx: Readonly<Record<string, readonly { priority: number; exchange: string }[]>>; txt: Readonly<Record<string, readonly (readonly string[])[]>> }
export interface EmailDnsResult { status: "pass" | "fail" | "blocked"; type: "MX" | "TXT"; name: string; reason: string; expected?: string; answers?: readonly string[] }

// The built-in list stays blocked until an operator supplies approved public values.
export const EXPECTED_EMAIL_DNS: readonly EmailDnsExpectedRecord[] = [
  { type: "MX", name: "fundlane.io", blocked: true },
  { type: "TXT", name: "fundlane.io", purpose: "spf", blocked: true },
  { type: "TXT", name: "_dmarc.fundlane.io", purpose: "dmarc", blocked: true },
  { type: "TXT", name: "<provider-selector>._domainkey.fundlane.io", purpose: "dkim", blocked: true },
]

function hostname(value: string): string { return value.toLowerCase().replace(/\.$/, "") }

function isDnsName(value: unknown, allowUnderscore = false): value is string {
  if (typeof value !== "string") return false
  const name = value.replace(/\.$/, "")
  return name.length > 0 && name.length <= 253 && name.split(".").every(label =>
    label.length > 0 && label.length <= 63 && (allowUnderscore ? /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/i : /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i).test(label))
}

function object(value: unknown, location: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${location} must be an object.`)
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find(key => !fields.includes(key))
  if (unknown) throw new Error(`${location} has unknown field "${unknown}".`)
  return record
}

export function parseEmailDnsManifest(input: unknown): readonly EmailDnsExpectedRecord[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) throw new Error("Expected DNS manifest must be a nonempty array of at most 50 records.")
  return input.map((entry: unknown, index: number) => {
    const location = `Expected DNS record ${index + 1}`
    const record = object(entry, location, ["type", "name", "values", "purpose", "value"])
    if (record.type !== "MX" && record.type !== "TXT") throw new Error(`${location} has invalid type; use MX or TXT.`)
    if (!isDnsName(record.name, true) || !/^(?:[a-z0-9_-]+\.)*fundlane\.io\.?$/i.test(record.name)) throw new Error(`${location} name must be a valid DNS name under fundlane.io.`)
    if (record.type === "MX") {
      object(entry, location, ["type", "name", "values"])
      if (!Array.isArray(record.values) || record.values.length === 0) throw new Error(`${location} values must be a nonempty array.`)
      const values = record.values.map((item: unknown, valueIndex: number) => {
        const where = `${location} value ${valueIndex + 1}`
        const value = object(item, where, ["priority", "target"])
        if (!Number.isInteger(value.priority) || (value.priority as number) < 0 || (value.priority as number) > 65535) throw new Error(`${where} priority must be an integer from 0 to 65535.`)
        if (!isDnsName(value.target)) throw new Error(`${where} target must be a valid DNS name.`)
        return { priority: value.priority as number, target: value.target }
      })
      return { type: "MX" as const, name: record.name, values }
    }
    object(entry, location, ["type", "name", "purpose", "value"])
    if (record.purpose !== "spf" && record.purpose !== "dkim" && record.purpose !== "dmarc" && record.purpose !== "other") throw new Error(`${location} purpose must be spf, dkim, dmarc, or other.`)
    if (typeof record.value !== "string" || record.value.trim().length === 0) throw new Error(`${location} value must be a nonempty string.`)
    return { type: "TXT" as const, name: record.name, purpose: record.purpose, value: record.value }
  })
}

export function normalizeTxtAnswers(answers: readonly (readonly string[])[]): string[] {
  return answers.map(chunks => chunks.join(""))
}

function displayExpected(record: Exclude<EmailDnsExpectedRecord, { blocked: true }>): string {
  return record.type === "MX"
    ? record.values.map(value => `${value.priority} ${hostname(value.target)}`).sort().join("; ")
    : record.value
}

export function evaluateEmailDns(expected: readonly EmailDnsExpectedRecord[], answers: EmailDnsAnswers): EmailDnsResult[] {
  return expected.map(record => {
    if (record.blocked) return { status: "blocked", type: record.type, name: record.name, reason: "supply the value from useSend's domain setup (or the approved policy) via --expected." }
    const expectation = displayExpected(record)
    if (record.type === "MX") {
      const actual = (answers.mx[record.name] ?? []).map(value => `${value.priority} ${hostname(value.exchange)}`).sort()
      const wanted = record.values.map(value => `${value.priority} ${hostname(value.target)}`).sort()
      const pass = actual.length === wanted.length && actual.every((value, index) => value === wanted[index])
      return { status: pass ? "pass" : "fail", type: record.type, name: record.name, reason: pass ? "expected record is present." : "MX priority/target set does not exactly match.", expected: expectation, answers: actual }
    }
    const actual = normalizeTxtAnswers(answers.txt[record.name] ?? [])
    const policyPrefix = record.purpose === "spf" ? "v=spf1" : record.purpose === "dmarc" ? "v=DMARC1" : null
    const candidates = policyPrefix ? actual.filter(value => value.toLowerCase().startsWith(policyPrefix.toLowerCase())) : actual
    const pass = record.purpose === "other" ? candidates.includes(record.value) : candidates.length === 1 && candidates[0] === record.value
    const reason = pass ? "expected record is present." : candidates.length > 1 ? `multiple conflicting ${record.purpose?.toUpperCase()} records were returned.` : `${record.purpose?.toUpperCase()} value does not exactly match.`
    return { status: pass ? "pass" : "fail", type: record.type, name: record.name, reason, expected: expectation, answers: actual }
  })
}

export function assertEmailDnsCheckEnabled(env: Readonly<Record<string, string | undefined>>): void {
  if (env.MCA_EMAIL_DNS_CHECK_ENABLED !== "true") throw new Error("Email DNS readiness check is disabled. Set MCA_EMAIL_DNS_CHECK_ENABLED=true to allow read-only public DNS lookups.")
}

export async function runEmailDnsCheck(input: {
  resolveMx: (name: string) => Promise<readonly { priority: number; exchange: string }[]>
  resolveTxt: (name: string) => Promise<readonly (readonly string[])[]>
  expected?: readonly EmailDnsExpectedRecord[]
}): Promise<EmailDnsResult[]> {
  const expected = input.expected ?? EXPECTED_EMAIL_DNS
  const answers: { mx: Record<string, readonly { priority: number; exchange: string }[]>; txt: Record<string, readonly (readonly string[])[]> } = { mx: {}, txt: {} }
  const errors = new Map<string, string>()
  for (const record of expected) {
    if (record.blocked) continue
    try {
      if (record.type === "MX") answers.mx[record.name] = await input.resolveMx(record.name)
      else answers.txt[record.name] = await input.resolveTxt(record.name)
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
      const message = error instanceof Error ? error.message.toLowerCase() : ""
      const category = code === "ENOTFOUND" || message.includes("nxdomain") ? "NXDOMAIN"
        : code === "ETIMEOUT" || message.includes("timed out") || message.includes("timeout") ? "timeout"
        : "resolver error"
      errors.set(`${record.type}:${record.name}`, category)
    }
  }
  return evaluateEmailDns(expected, answers).map(result => {
    const error = errors.get(`${result.type}:${result.name}`)
    return error ? { ...result, status: "fail", reason: `DNS lookup failed: ${error}` } : result
  })
}

export function formatEmailDnsReport(results: readonly EmailDnsResult[]): string {
  const overall = results.some(result => result.status === "fail") ? "FAIL" : results.some(result => result.status === "blocked") ? "BLOCKED" : "PASS"
  const lines = [`Email DNS readiness: ${overall}`]
  for (const result of results) {
    if (result.status === "pass") lines.push(`PASS ${result.type} ${result.name}: expected record is present.`)
    else if (result.status === "blocked") lines.push(`BLOCKED ${result.type} ${result.name}: ${result.reason}`)
    else lines.push(`FAIL ${result.type} ${result.name}: ${result.reason}`)
  }
  lines.push("DNS readiness does not prove provider verification, mailbox receipt, or outbound delivery.")
  return `${lines.join("\n")}\n`
}

async function expectedFromArgs(argv: readonly string[]): Promise<readonly EmailDnsExpectedRecord[]> {
  const expectedArg = argv.find(value => value.startsWith("--expected="))?.slice("--expected=".length)
  const selectorArg = argv.find(value => value.startsWith("--dkim-selector="))?.slice("--dkim-selector=".length)
  const valueArg = argv.find(value => value.startsWith("--dkim-value="))?.slice("--dkim-value=".length)
  if (argv.some(value => value.startsWith("--expected=")) && argv.some(value => value.startsWith("--dkim-selector=") || value.startsWith("--dkim-value="))) throw new Error("--expected cannot be combined with --dkim-selector or --dkim-value.")
  if (argv.some(value => value.startsWith("--expected="))) {
    if (!expectedArg) throw new Error("Supply --expected=PATH to a JSON manifest.")
    let contents: string
    try { contents = await readFile(expectedArg, "utf8") }
    catch (error) { throw new Error(`Cannot read expected DNS manifest "${expectedArg}": ${error instanceof Error ? error.message : String(error)}`) }
    let parsed: unknown
    try { parsed = JSON.parse(contents) }
    catch { throw new Error(`Expected DNS manifest "${expectedArg}" is not valid JSON.`) }
    return parseEmailDnsManifest(parsed)
  }
  if (!selectorArg && !valueArg) return EXPECTED_EMAIL_DNS
  if (!selectorArg || !valueArg || !/^[a-zA-Z0-9_-]+$/.test(selectorArg)) throw new Error("Supply both --dkim-selector=SELECTOR and --dkim-value=VALUE.")
  return EXPECTED_EMAIL_DNS.map(record => "purpose" in record && record.purpose === "dkim" ? { type: "TXT", name: `${selectorArg}._domainkey.fundlane.io`, purpose: "dkim", value: valueArg } : record)
}

interface OutputWriter { write(value: string): unknown }

export async function main(
  argv = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: { stdout: OutputWriter; stderr: OutputWriter } = { stdout: process.stdout, stderr: process.stderr },
  resolver = { resolveMx, resolveTxt },
): Promise<number> {
  try {
    assertEmailDnsCheckEnabled(env)
    const results = await runEmailDnsCheck({ ...resolver, expected: await expectedFromArgs(argv) })
    io.stdout.write(formatEmailDnsReport(results))
    return results.every(result => result.status === "pass") ? 0 : 1
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : "Email DNS readiness check failed."}\n`)
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().then(code => { process.exitCode = code })
