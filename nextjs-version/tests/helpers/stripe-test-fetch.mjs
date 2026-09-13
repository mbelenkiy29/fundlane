// Imported only by the HTTP test server via NODE_OPTIONS; never imported by application code.
// Intercept the real SDK's HTTP transport so tests exercise Stripe's actual wire protocol.
const target = process.env.MCA_STRIPE_TEST_API_ORIGIN
if (!target || !/^http:\/\/127\.0\.0\.1:\d+$/.test(target)) throw new Error("Stripe HTTP test origin must be an isolated loopback listener.")
const originalFetch = globalThis.fetch
const intercepted = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
  if (url.origin === "https://api.stripe.com") return originalFetch(new URL(url.pathname + url.search, target), init)
  return originalFetch(input, init)
}
globalThis.fetch = intercepted
