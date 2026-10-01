import { randomUUID } from "node:crypto"
import type Stripe from "stripe"
import { BILLING_CATALOG } from "../../src/lib/mca/billing-catalog"
import type { StripeBillingClient } from "../../src/lib/mca/billing"
export const enrollmentTestEnv = {
  MCA_ONBOARDING_RUNTIME_ENABLED: "true",
  MCA_STRIPE_FIRST_ONBOARDING_ENABLED: "true",
  MCA_SIGNUP_MODE: "open",
  MCA_STRIPE_BILLING_ENABLED: "true",
  MCA_STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "rk_test_fixture",
  STRIPE_BASE_PRICE_ID: "price_base",
  STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats",
  STRIPE_BILLING_WEBHOOK_SECRET: "whsec_fixture",
  MCA_STRIPE_EXPECTED_ACCOUNT_ID: "acct_fixture",
  MCA_APP_ORIGIN: "http://localhost:3000",
  MCA_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  STRIPE_BILLING_PORTAL_CONFIGURATION: "bpc_fixture",
}
export const resumeSecret = () => randomUUID() + randomUUID()
export function stripeFixture() {
  const suffix = randomUUID().replaceAll("-", ""),
    now = Math.floor(Date.now() / 1000),
    customerId = `cus_${suffix}`
  const subscription = {
    id: `sub_${suffix}`,
    customer: customerId,
    livemode: false,
    status: "trialing",
    trial_start: now,
    trial_end: now + 1209600,
    default_payment_method: `pm_${suffix}`,
    pending_setup_intent: null,
    collection_method: "charge_automatically",
    cancel_at_period_end: false,
    cancel_at: null,
    pause_collection: null,
    metadata: {} as Record<string, string>,
    items: {
      data: [
        {
          id: `si_${suffix}`,
          price: { id: "price_base" },
          quantity: 1,
          current_period_start: now,
          current_period_end: now + 1209600,
        },
      ],
    },
  }
  const state = {
    account: "acct_fixture",
    priceAmount: 39900,
    loseCreate: false,
    failRead: false,
    cancelLoss: false,
    cancelCalls: 0,
    createCalls: [] as {
      key: string
      params: Stripe.Checkout.SessionCreateParams
    }[],
    sessions: new Map<string, Stripe.Checkout.Session>(),
    invoices: [] as Stripe.Invoice[],
    payments: [] as Stripe.InvoicePayment[],
    subscription,
    customer: {
      id: customerId,
      livemode: false,
      metadata: {} as Record<string, string>,
      invoice_settings: { default_payment_method: `pm_${suffix}` },
    },
    method: {
      id: `pm_${suffix}`,
      customer: customerId,
      livemode: false,
      type: "card",
      card: { fingerprint: `finger_${suffix}`, exp_year: 2035, exp_month: 12 },
    },
    onCreate: undefined as
      | undefined
      | ((p: Stripe.Checkout.SessionCreateParams) => Promise<void>),
    portalCustomer: "",
    portalReturnUrl: "",
  }
  const client = {
    accounts: { retrieve: async () => ({ id: state.account }) },
    prices: {
      retrieve: async (id: string) => ({
        id,
        active: true,
        livemode: false,
        currency: "usd",
        unit_amount: id === "price_base" ? state.priceAmount : null,
        billing_scheme: id === "price_base" ? "per_unit" : "tiered",
        tiers_mode: "graduated",
        tiers: BILLING_CATALOG.additionalSeats.tiers.map((t) => ({
          up_to: t.upTo,
          unit_amount: t.unitAmountCents,
        })),
        recurring: {
          interval: "month",
          interval_count: 1,
          usage_type: "licensed",
        },
        tax_behavior: "exclusive",
      }),
    },
    checkout: {
      sessions: {
        create: async (
          params: Stripe.Checkout.SessionCreateParams,
          options: { idempotencyKey: string }
        ) => {
          state.createCalls.push({
            params: structuredClone(params),
            key: options.idempotencyKey,
          })
          let session = state.sessions.get(options.idempotencyKey)
          if (!session) {
            session = {
              id: `cs_${suffix}_${state.sessions.size}`,
              object: "checkout.session",
              mode: "subscription",
              status: "open",
              livemode: false,
              url: "https://checkout.stripe.com/c/pay/test",
              created: now,
              expires_at: params.expires_at,
              client_reference_id: params.client_reference_id,
              metadata: params.metadata,
              customer: null,
              subscription: null,
              automatic_tax: {
                enabled: params.automatic_tax?.enabled ?? false,
              },
              allow_promotion_codes: params.allow_promotion_codes ?? false,
              managed_payments: { enabled: false },
              payment_method_collection: "always",
              payment_method_types: ["card"],
              line_items: {
                data: [{ price: { id: "price_base" }, quantity: 1 }],
                has_more: false,
              },
            } as unknown as Stripe.Checkout.Session
            state.sessions.set(options.idempotencyKey, session)
            state.subscription.metadata = params.subscription_data
              ?.metadata as Record<string, string>
          }
          if (state.onCreate) await state.onCreate(params)
          if (state.loseCreate) {
            state.loseCreate = false
            throw new Error("response lost")
          }
          return structuredClone(session)
        },
        retrieve: async (id: string) => {
          if (state.failRead) throw new Error("provider unavailable")
          const s = [...state.sessions.values()].find((s) => s.id === id)
          if (!s) throw new Error("session missing")
          return structuredClone(s)
        },
        list: async () => ({
          data: structuredClone([...state.sessions.values()]),
          has_more: false,
        }),
      },
    },
    customers: { retrieve: async () => structuredClone(state.customer) },
    subscriptions: {
      retrieve: async () => structuredClone(state.subscription),
      list: async () => ({
        data: [structuredClone(state.subscription)],
        has_more: false,
      }),
      cancel: async (id: string) => {
        if (id !== state.subscription.id)
          throw new Error("foreign cancellation")
        state.cancelCalls++
        state.subscription.status = "canceled"
        if (state.cancelLoss) throw new Error("response lost")
        return structuredClone(state.subscription)
      },
    },
    paymentMethods: { retrieve: async () => structuredClone(state.method) },
    setupIntents: {
      retrieve: async () => ({
        id: "seti_fixture",
        customer: customerId,
        livemode: false,
        status: "succeeded",
        payment_method: state.method.id,
      }),
    },
    invoices: {
      list: async () => ({
        data: structuredClone(state.invoices),
        has_more: false,
      }),
    },
    invoicePayments: {
      list: async () => ({ data: state.payments, has_more: false }),
    },
    charges: { list: async () => ({ data: [], has_more: false }) },
    paymentIntents: { list: async () => ({ data: [], has_more: false }) },
    billingPortal: {
      configurations: {
        retrieve: async () => ({
          active: true,
          livemode: false,
          features: {
            subscription_update: { enabled: false },
            payment_method_update: { enabled: true },
            invoice_history: { enabled: true },
            subscription_cancel: { enabled: true, mode: "at_period_end" },
          },
        }),
      },
      sessions: {
        create: async (p: { customer: string; return_url: string }) => {
          state.portalCustomer = p.customer
          state.portalReturnUrl = p.return_url
          return { url: "https://billing.stripe.com/p/session/test" }
        },
      },
    },
  } as unknown as StripeBillingClient
  function complete() {
    const session = [...state.sessions.values()].at(-1)!
    Object.assign(session, {
      status: "complete",
      customer: customerId,
      subscription: subscription.id,
      customer_details: {
        email: `owner${suffix}@example.test`,
        business_name: "Synthetic company",
      },
      collected_information: { business_name: "Synthetic company" },
    })
    return session
  }
  function invoice(amount = 0, reason = "subscription_create") {
    return {
      id: `in_${randomUUID()}`,
      customer: customerId,
      livemode: false,
      status: "paid",
      billing_reason: reason,
      currency: "usd",
      amount_due: amount,
      amount_paid: amount,
      amount_remaining: 0,
      hosted_invoice_url: null,
      period_start: now,
      period_end: now + 2592000,
      created: now,
      parent: { subscription_details: { subscription: subscription.id } },
      attempt_count: 0,
      due_date: null,
      status_transitions: { finalized_at: now, paid_at: now },
      lines: { data: [], has_more: false },
    } as unknown as Stripe.Invoice
  }
  return { state, client, complete, invoice }
}
