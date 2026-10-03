import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import {
  API_CACHE_HEADERS,
  CONTENT_SECURITY_POLICY,
  DOCUMENT_SECURITY_HEADERS,
  FONT_CORS_HEADERS,
  PERMISSIONS_POLICY,
  STRICT_TRANSPORT_SECURITY,
  headerValue,
  nextConfigHeaders,
} from "../src/lib/mca/security-headers"

function directive(name: string): string {
  const match = CONTENT_SECURITY_POLICY.split("; ").find((part) => part === name || part.startsWith(`${name} `))
  assert.ok(match, `missing CSP directive ${name}`)
  return match
}

test("enforced CSP allowlists first-party and known third-party loads", () => {
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/)
  assert.match(directive("script-src"), /cdn\.platform\.openai\.com/)
  assert.match(directive("script-src"), /va\.vercel-scripts\.com/)
  assert.match(directive("script-src"), /vercel\.live/)
  assert.match(directive("script-src"), /accounts\.google\.com/)
  assert.match(directive("connect-src"), /\*\.supabase\.co/)
  assert.match(directive("connect-src"), /vitals\.vercel-insights\.com/)
  assert.match(directive("frame-src"), /form\.jotform\.com/)
  assert.match(directive("frame-src"), /blob:/)
  assert.match(directive("form-action"), /accounts\.google\.com/)
  assert.match(directive("form-action"), /checkout\.stripe\.com/)
  assert.equal(directive("object-src"), "object-src 'none'")
  assert.equal(directive("frame-ancestors"), "frame-ancestors 'none'")
  assert.match(directive("img-src"), /https:/)
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /'unsafe-eval'/)
})

test("document headers include CSP, HSTS, Permissions-Policy, and no wildcard CORS", () => {
  assert.equal(headerValue(DOCUMENT_SECURITY_HEADERS, "Content-Security-Policy"), CONTENT_SECURITY_POLICY)
  assert.equal(headerValue(DOCUMENT_SECURITY_HEADERS, "Strict-Transport-Security"), STRICT_TRANSPORT_SECURITY)
  assert.match(STRICT_TRANSPORT_SECURITY, /includeSubDomains/)
  assert.match(STRICT_TRANSPORT_SECURITY, /preload/)
  assert.equal(headerValue(DOCUMENT_SECURITY_HEADERS, "Permissions-Policy"), PERMISSIONS_POLICY)
  for (const feature of ["camera=()", "microphone=()", "geolocation=()", "payment=()"]) {
    assert.match(PERMISSIONS_POLICY, new RegExp(feature.replace("()", "\\(\\)")))
  }
  // Feedback screenshots capture this page only; other origins stay blocked.
  assert.match(PERMISSIONS_POLICY, /display-capture=\(self\)/)
  assert.equal(headerValue(DOCUMENT_SECURITY_HEADERS, "X-Frame-Options"), "DENY")
  assert.equal(headerValue(DOCUMENT_SECURITY_HEADERS, "Access-Control-Allow-Origin"), undefined)
})

test("CORS wildcard is scoped to public fonts only", () => {
  assert.equal(headerValue(FONT_CORS_HEADERS, "Access-Control-Allow-Origin"), "*")
  assert.equal(headerValue(API_CACHE_HEADERS, "Access-Control-Allow-Origin"), undefined)
  const sources = nextConfigHeaders()
  assert.deepEqual(sources.map((entry) => entry.source), ["/fonts/:path*", "/api/:path*", "/(.*)", "/enrollment", "/api/enrollment/invite"])
  const font = sources.find((entry) => entry.source === "/fonts/:path*")
  const documents = sources.find((entry) => entry.source === "/(.*)")
  const api = sources.find((entry) => entry.source === "/api/:path*")
  assert.equal(headerValue(font!.headers, "Access-Control-Allow-Origin"), "*")
  assert.equal(headerValue(documents!.headers, "Access-Control-Allow-Origin"), undefined)
  assert.equal(headerValue(api!.headers, "Access-Control-Allow-Origin"), undefined)
})

test("invite pages and their POST send no referrer; the later entry overrides the document default", () => {
  const sources = nextConfigHeaders()
  const documents = sources.findIndex((entry) => entry.source === "/(.*)")
  for (const path of ["/enrollment", "/api/enrollment/invite"]) {
    const index = sources.findIndex((entry) => entry.source === path)
    assert.ok(index > documents, path)
    assert.equal(headerValue(sources[index].headers, "Referrer-Policy"), "no-referrer")
  }
})

test("next.config applies the shared header map", () => {
  const config = readFileSync(resolve("next.config.ts"), "utf8")
  assert.match(config, /nextConfigHeaders/)
  assert.doesNotMatch(config, /Access-Control-Allow-Origin/)
})
