import assert from "node:assert/strict"
import test from "node:test"
import { getRedirectUrl, unstable_getResponseFromNextConfig } from "next/experimental/testing/server"
import nextConfig from "../next.config"

test("app homepage enters the existing dashboard gate without changing marketing or signup routes", async () => {
  const response = await unstable_getResponseFromNextConfig({ url: "https://app.fundlane.io/?ref=pricing", nextConfig })
  assert.equal(response.status, 307)
  assert.equal(getRedirectUrl(response), "https://app.fundlane.io/dashboard?ref=pricing")
  for (const url of ["https://fundlane.io/", "http://localhost:3000/", "https://preview.vercel.app/", "https://app.fundlane.io/get-started", "https://app.fundlane.io/sign-in", "https://app.fundlane.io/api/webhooks/stripe"]) {
    assert.equal(getRedirectUrl(await unstable_getResponseFromNextConfig({ url, nextConfig })), null, url)
  }
})
