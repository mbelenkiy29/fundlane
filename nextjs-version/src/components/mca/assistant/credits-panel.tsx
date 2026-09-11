"use client"
import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  assistantJson,
  type CreditBalance,
  type CreditSummary
} from "./credit-balance"
type AdminState = {
  members: Array<{
    id: string
    name: string
    email: string
    balance: CreditBalance
    consumed: number
  }>
  settings: { mode: "percent" | "fixed"; threshold: number }
  purchasesAvailable: boolean
}
export function CreditsPanel() {
  const search = useSearchParams(),
    [self, setSelf] = useState<CreditSummary | null>(null),
    [admin, setAdmin] = useState<AdminState | null>(null)
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(search.get("user") ?? "")
  const [mode, setMode] = useState<"percent" | "fixed">("percent"),
    [threshold, setThreshold] = useState(20)
  const purchaseKeys = useRef<Record<string, string>>({}),
    handledPurchase = useRef<string | null>(null)
  const load = useCallback(async () => {
    const data = await assistantJson<CreditSummary>(
      "/api/mca/assistant/credits"
    )
    setSelf(data)
    if (data.canManage) {
      const a = await assistantJson<AdminState>(
        "/api/mca/assistant/credits/admin"
      )
      setAdmin(a)
      setMode(a.settings.mode)
      setThreshold(a.settings.threshold)
      setSelected((s) => s || a.members[0]?.id || "")
    }
  }, [])
  useEffect(() => {
    void load().catch((e) => setError(e.message))
  }, [load])
  useEffect(() => {
    const id = search.get("purchase")
    if (
      !id ||
      !self?.canManage ||
      (search.get("workspace") &&
        search.get("workspace") !== self.workspaceId) ||
      handledPurchase.current === id
    )
      return
    handledPurchase.current = id
    void assistantJson<{ state: string }>(
      "/api/mca/assistant/credits/reconcile",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseId: id })
      }
    )
      .then(async (r) => {
        setNotice(
          r.state === "paid"
            ? "Payment confirmed. Credits have been added."
            : "Payment is being confirmed. Credits will appear after payment succeeds."
        )
        await load()
      })
      .catch((e) => setError(e.message))
  }, [search, self?.canManage, self?.workspaceId, load])
  async function buy() {
    if (!selected) return
    setBusy(true)
    setError("")
    try {
      purchaseKeys.current[selected] ??= crypto.randomUUID()
      const d = await assistantJson<{ url: string | null }>(
        "/api/mca/assistant/credits/checkout",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipientUserId: selected,
            requestId: purchaseKeys.current[selected]
          })
        }
      )
      if (!d.url || new URL(d.url).hostname !== "checkout.stripe.com")
        throw new Error(
          "Checkout is unavailable. Refresh the purchase status before trying again."
        )
      window.location.assign(d.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Purchase unavailable.")
    } finally {
      setBusy(false)
    }
  }
  async function save() {
    setBusy(true)
    setError("")
    try {
      await assistantJson("/api/mca/assistant/credits/admin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, threshold })
      })
      setNotice(
        "Alert settings saved. They apply on the next credit balance change."
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings.")
    } finally {
      setBusy(false)
    }
  }
  if (
    self &&
    search.get("workspace") &&
    search.get("workspace") !== self.workspaceId
  )
    return (
      <p role="alert" className="rounded-lg border p-5">
        This alert belongs to another company. Switch companies using your
        account menu, then reopen this alert.
      </p>
    )
  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/assistant"
          className="text-sm text-muted-foreground underline"
        >
          Back to AI Assistant
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">AI credits</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          One request uses one credit, including its tool steps and approval
          continuation.
        </p>
      </header>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {notice}
        </p>
      )}
      {self ? (
        <section className="rounded-xl border p-5">
          <h2 className="font-medium">Your balance</h2>
          <p className="mt-3 text-3xl font-semibold">
            {self.balance.total}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              credits available
            </span>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {self.balance.included} of {self.balance.allowance} monthly credits
            left · {self.balance.purchased} purchased · {self.balance.reserved}{" "}
            reserved
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Monthly credits reset{" "}
            {new Date(self.balance.resetAt).toLocaleString()}. Purchased credits
            carry forward.
          </p>
          {self.balance.debt > 0 && (
            <p className="mt-2 text-sm">
              {self.balance.debt} purchased credits were reversed after use.
              Future purchases first repay this balance.
            </p>
          )}
          {!self.canManage && (
            <p className="mt-3 text-sm">
              Ask your company admin to buy more credits or upgrade the company
              plan.
            </p>
          )}
        </section>
      ) : (
        <p role="status">Loading credits…</p>
      )}
      {admin && (
        <>
          <section className="space-y-4 rounded-xl border p-5">
            <h2 className="font-medium">Company usage</h2>
            <p className="text-sm text-muted-foreground">
              Balances are private to this company. Chat contents are private to
              each user.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="p-2">User</th>
                    <th className="p-2">Used this month</th>
                    <th className="p-2">Monthly left</th>
                    <th className="p-2">Purchased</th>
                    <th className="p-2">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {admin.members.map((u) => (
                    <tr key={u.id} className="border-b">
                      <td className="p-2">
                        {u.name}
                        <span className="block text-xs text-muted-foreground">
                          {u.email}
                        </span>
                      </td>
                      <td className="p-2">{u.consumed}</td>
                      <td className="p-2">
                        {u.balance.included} / {u.balance.allowance}
                      </td>
                      <td className="p-2">{u.balance.purchased}</td>
                      <td className="p-2">{u.balance.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Link
              href="/settings/billing"
              className="inline-block text-sm underline"
            >
              Manage company plan
            </Link>
          </section>
          <section className="space-y-4 rounded-xl border p-5">
            <h2 className="font-medium">Buy extra credits</h2>
            <p className="text-sm">
              100 credits for $10 USD. Added to the selected user in this
              company after payment.
            </p>
            <label className="block text-sm" htmlFor="credit-recipient">
              Recipient
            </label>
            <select
              id="credit-recipient"
              className="w-full rounded-md border bg-background p-2 sm:max-w-md"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {admin.members.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {u.email}
                </option>
              ))}
            </select>
            <div>
              <Button
                onClick={() => void buy()}
                disabled={busy || !selected || !admin.purchasesAvailable}
              >
                Buy 100 credits · $10
              </Button>
            </div>
            {!admin.purchasesAvailable && (
              <p role="status" className="text-sm text-muted-foreground">
                Purchases are not configured in this environment yet.
              </p>
            )}
          </section>
          <section className="space-y-4 rounded-xl border p-5">
            <h2 className="font-medium">Low-credit alerts</h2>
            <p className="text-sm text-muted-foreground">
              Active company admins receive an in-app alert and email at the
              warning threshold and again at zero. Purchased credits count
              toward the remaining balance.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span>Threshold type</span>
                <select
                  className="block w-full rounded-md border bg-background p-2"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  <option value="percent">
                    Percentage of monthly allowance remaining
                  </option>
                  <option value="fixed">Number of credits remaining</option>
                </select>
              </label>
              <label className="space-y-2 text-sm">
                <span>
                  {mode === "percent"
                    ? "Percentage remaining"
                    : "Credits remaining"}
                </span>
                <Input
                  type="number"
                  min={1}
                  max={mode === "percent" ? 100 : 100000}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                />
              </label>
            </div>
            <Button onClick={() => void save()} disabled={busy}>
              Save alert settings
            </Button>
          </section>
        </>
      )}
      {self && (
        <section className="rounded-xl border p-5">
          <h2 className="mb-3 font-medium">Your recent credit activity</h2>
          <ul className="divide-y">
            {self.ledger.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap justify-between gap-2 py-2 text-sm"
              >
                <span>
                  {e.kind.replaceAll("_", " ")}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString()}
                  </span>
                </span>
                <span>
                  {e.amount > 0 ? "+" : ""}
                  {e.amount} · {e.source}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
