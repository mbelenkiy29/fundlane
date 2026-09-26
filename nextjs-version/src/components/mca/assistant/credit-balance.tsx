"use client"
import Link from "next/link"
import { useEffect, useState } from "react"
export interface CreditBalance {
  allowance: number
  included: number
  purchased: number
  reserved: number
  debt: number
  total: number
  resetAt: string
}
export interface CreditSummary {
  workspaceId: string
  balance: CreditBalance
  canManage: boolean
  purchasesAvailable: boolean
  ledger: Array<{
    id: string
    kind: string
    amount: number
    source: string
    createdAt: string
  }>
}
export async function assistantJson<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const r = await fetch(url, init)
  const d = await r.json()
  if (!r.ok) throw new Error(d.error?.message ?? "This action is unavailable.")
  return d
}
export function CreditBalanceBadge() {
  const [state, setState] = useState<CreditSummary | null>(null),
    [error, setError] = useState("")
  useEffect(() => {
    let alive = true
    const refresh = () => {
      void assistantJson<CreditSummary>("/api/mca/assistant/credits")
        .then((s) => {
          if (alive) {
            setState(s)
            setError("")
          }
        })
        .catch((e) => {
          if (alive) setError(e.message)
        })
    }
    refresh()
    window.addEventListener("mca-credits-changed", refresh)
    return () => {
      alive = false
      window.removeEventListener("mca-credits-changed", refresh)
    }
  }, [])
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {error ||
          (!state
            ? "Loading AI credits…"
            : `${state.balance.total} credits left · ${state.balance.included} monthly + ${state.balance.purchased} purchased`)}
      </span>
      <Link className="underline underline-offset-4" href="/assistant/credits">
        AI credits
      </Link>
      {state?.balance.total === 0 && (
        <p className="w-full text-amber-700 dark:text-amber-400">
          No credits remain.{" "}
          {state.canManage
            ? state.purchasesAvailable
              ? "Buy a credit pack or upgrade your company plan."
              : "Upgrade your company plan."
            : state.purchasesAvailable
              ? "Ask your company admin to buy more credits."
              : "Ask your company admin about your plan."}{" "}
          Included credits reset{" "}
          {new Date(state.balance.resetAt).toLocaleDateString()}.
        </p>
      )}

    </div>
  )
}
