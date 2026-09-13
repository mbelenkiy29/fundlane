import { createServer } from "node:http"
export async function createStripeHttpFixture() {
  const subscriptions = new Map(), customers = new Map(), checkouts = new Map(), calls = []
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost")
      let raw = ""; for await (const chunk of req) raw += chunk
      const body = new URLSearchParams(raw)
      calls.push({ method: req.method, path: url.pathname, body })
      let data
      if (req.method === "GET" && url.pathname === "/v1/subscriptions") data = { object: "list", data: subscriptions.get(url.searchParams.get("customer")) ?? [], has_more: false }
      else if (req.method === "GET" && url.pathname.startsWith("/v1/prices/")) { const id = url.pathname.split("/").at(-1); data = { id, active: true, livemode: false, currency: "usd", unit_amount: id === "price_starter" ? 4900 : 9900, recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }
      else if (req.method === "POST" && url.pathname === "/v1/customers") { const id = `cus_${customers.size + 1}`; data = { id, livemode: false, metadata: { workspace_id: body.get("metadata[workspace_id]") } }; customers.set(id, data) }
      else if (req.method === "GET" && url.pathname.startsWith("/v1/customers/")) data = customers.get(url.pathname.split("/").at(-1))
      else if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") { const id = `cs_test_${checkouts.size + 1}`; data = { id, livemode: false, status: "open", url: `https://checkout.stripe.com/${id}`, customer: body.get("customer") }; checkouts.set(id, data) }
      else if (req.method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) data = checkouts.get(url.pathname.split("/").at(-1))
      else if (req.method === "POST" && url.pathname === "/v1/billing_portal/sessions") data = { id: "bps_test", url: "https://billing.stripe.com/test" }
      if (!data) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: "Fixture route or object not found" } })); return }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data))
    } catch { res.writeHead(500).end() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, subscriptions, customers, checkouts, calls, close: () => new Promise(resolve => server.close(resolve)) }
}
