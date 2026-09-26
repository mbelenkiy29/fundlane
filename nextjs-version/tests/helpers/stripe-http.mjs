import { createServer } from "node:http"
import { BILLING_CATALOG } from "../../src/lib/mca/billing-catalog.ts"
export async function createStripeHttpFixture() {
  const subscriptions = new Map(), customers = new Map(), checkouts = new Map(), invoices = new Map(), schedules = new Map(), calls = []
  let subscriptionListDelayMs = 0
  const scheduleCreations = new Map()
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost")
      let raw = ""; for await (const chunk of req) raw += chunk
      const body = new URLSearchParams(raw)
      calls.push({ method: req.method, path: url.pathname, body, idempotencyKey: req.headers["idempotency-key"], apiVersion: req.headers["stripe-version"] })
      let data
      if (req.method === "GET" && url.pathname === "/v1/subscriptions") { if (subscriptionListDelayMs) await new Promise(resolve => setTimeout(resolve, subscriptionListDelayMs)); data = { object: "list", data: subscriptions.get(url.searchParams.get("customer")) ?? [], has_more: false } }
      else if (req.method === "GET" && url.pathname.startsWith("/v1/prices/")) {
        const id = url.pathname.split("/").at(-1)
        data = { id, active: true, livemode: false, currency: "usd", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, ...(id === "price_base" ? { billing_scheme: "per_unit", unit_amount: BILLING_CATALOG.base.unitAmountCents } : { billing_scheme: "tiered", tiers_mode: "graduated", tiers: BILLING_CATALOG.additionalSeats.tiers.map(tier => ({ up_to: tier.upTo, unit_amount: tier.unitAmountCents, flat_amount: null })) }) }
      }
      else if (req.method === "GET" && url.pathname === "/v1/invoices") data = { object: "list", data: invoices.get(url.searchParams.get("customer")) ?? [], has_more: false }
      else if (url.pathname.startsWith("/v1/subscriptions/")) {
        data = [...subscriptions.values()].flat().find(value => value.id === url.pathname.split("/").at(-1))
        if (data && req.method === "POST") {
          if (body.has("cancel_at_period_end")) { data.cancel_at_period_end = body.get("cancel_at_period_end") === "true"; data.cancel_at = data.cancel_at_period_end ? data.items.data[0].current_period_end : null }
          if (body.has("pause_collection")) data.pause_collection = null
          else if (body.has("pause_collection[behavior]")) data.pause_collection = { behavior: body.get("pause_collection[behavior]") }
        }
      }
      else if (req.method === "POST" && url.pathname === "/v1/subscription_schedules") {
        if ([...body.keys()].some(key=>key!=="from_subscription")) {
          res.writeHead(400,{"content-type":"application/json"}).end(JSON.stringify({error:{type:"invalid_request_error",message:"Other parameters cannot be set with from_subscription"}}));return
        }
        const cached=scheduleCreations.get(req.headers["idempotency-key"])
        if(cached){
          if(cached.body!==raw){res.writeHead(400,{"content-type":"application/json"}).end(JSON.stringify({error:{type:"idempotency_error",message:"Idempotency parameters differ"}}));return}
          res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(cached.response));return
        }
        const sub = [...subscriptions.values()].flat().find(value => value.id === body.get("from_subscription"))
        if(sub?.schedule){res.writeHead(400,{"content-type":"application/json"}).end(JSON.stringify({error:{type:"invalid_request_error",message:"Subscription already has a schedule"}}));return}
        if (sub) {
          const id = `sub_sched_${schedules.size + 1}`
          data = { id, customer:sub.customer, subscription:sub.id, livemode:sub.livemode, status:"active", current_phase:{start_date:sub.items.data[0].current_period_start,end_date:sub.items.data[0].current_period_end}, billing_mode: sub.billing_mode, metadata: {}, phases: [{ start_date: sub.items.data[0].current_period_start, end_date: sub.items.data[0].current_period_end, items:sub.items.data.map(item=>({price:item.price.id,quantity:item.quantity})) }] }
          schedules.set(id, data); sub.schedule = id
          if(req.headers["idempotency-key"]) scheduleCreations.set(req.headers["idempotency-key"],{body:raw,response:structuredClone(data)})
        }
      }
      else if (url.pathname.startsWith("/v1/subscription_schedules/")) {
        const scheduleId = url.pathname.split("/")[3]
        data = schedules.get(scheduleId)
        if(data && req.method==="POST" && url.pathname.endsWith("/release")) {
          data.status="released"
          const sub=[...subscriptions.values()].flat().find(value=>value.id===data.subscription)
          if(sub) sub.schedule=null
        }
        if(data && req.method==="POST") for(const key of ["workspace_id","selected_seats"]) if(body.has(`metadata[${key}]`)) data.metadata[key]=body.get(`metadata[${key}]`)
        if(data && req.method==="POST" && body.has("phases[1][start_date]")) {
          const items=[]
          for(let index=0;body.has(`phases[1][items][${index}][price]`);index++) items.push({price:body.get(`phases[1][items][${index}][price]`),quantity:Number(body.get(`phases[1][items][${index}][quantity]`))})
          data.phases=[data.phases[0],{start_date:Number(body.get("phases[1][start_date]")),items}]
          data.end_behavior=body.get("end_behavior")
        }
        if(data && req.method==="POST" && body.get("end_behavior")==="cancel") {
          data.end_behavior="cancel"
          data.phases=[{...data.phases.find(phase=>phase.start_date===data.current_phase.start_date),end_date:Number(body.get("phases[0][end_date]"))}]
          const sub=[...subscriptions.values()].flat().find(value=>value.id===data.subscription)
          if(sub) sub.cancel_at=data.phases[0].end_date
        }
      }
      else if (req.method === "POST" && url.pathname.startsWith("/v1/invoices/")) {
        data = [...invoices.values()].flat().find(value => value.id === url.pathname.split("/")[3])
        if (data && body.has("auto_advance")) data.auto_advance = body.get("auto_advance") === "true"
        if (data && url.pathname.endsWith("/finalize")) {
          data.status = "open"
          data.hosted_invoice_url = `https://invoice.stripe.com/i/${data.id}`
          data.status_transitions = { ...data.status_transitions, finalized_at: Math.floor(Date.now() / 1000) }
        }
      }
      else if (req.method === "GET" && url.pathname.endsWith("/lines")) {
        const invoice = [...invoices.values()].flat().find(value => value.id === url.pathname.split("/")[3])
        const lines = invoice?.lines?.data ?? [], after = url.searchParams.get("starting_after")
        data = { object: "list", data: lines.slice(after ? lines.findIndex(line => line.id === after) + 1 : 0), has_more: false }
      }
      else if (req.method === "GET" && ["/v1/invoice_payments", "/v1/charges", "/v1/refunds", "/v1/disputes"].includes(url.pathname)) data = { object: "list", data: [], has_more: false }
      else if (req.method === "POST" && url.pathname === "/v1/customers") { const id = `cus_${customers.size + 1}`; data = { id, livemode: false, metadata: { workspace_id: body.get("metadata[workspace_id]") } }; customers.set(id, data) }
      else if (req.method === "GET" && url.pathname.startsWith("/v1/customers/")) data = customers.get(url.pathname.split("/").at(-1))
      else if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") { const id = `cs_test_${checkouts.size + 1}`; data = { id, livemode: false, status: "open", url: `https://checkout.stripe.com/${id}`, customer: body.get("customer") }; checkouts.set(id, data) }
      else if (req.method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) data = checkouts.get(url.pathname.split("/").at(-1))
      else if (req.method === "POST" && url.pathname === "/v1/billing_portal/sessions") data = { id: "bps_test", url: "https://billing.stripe.com/test" }
      else if (req.method === "GET" && url.pathname === "/v1/billing_portal/configurations/bpc_fixture") data = { id: "bpc_fixture", active: true, livemode: false, features: { subscription_update: { enabled: false }, payment_method_update: { enabled: true }, invoice_history: { enabled: true }, subscription_cancel: { enabled: true, mode: "at_period_end" } } }
      if (!data) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "invalid_request_error", message: "Fixture route or object not found" } })); return }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data))
    } catch { res.writeHead(500).end() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, subscriptions, customers, checkouts, invoices, schedules, calls, setSubscriptionListDelay: ms => { subscriptionListDelayMs = ms }, close: () => new Promise(resolve => server.close(resolve)) }
}
