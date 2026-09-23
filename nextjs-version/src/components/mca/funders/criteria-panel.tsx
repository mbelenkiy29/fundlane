"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { RequestError, requestJson } from "@/lib/mca/client"
import { CRITERIA_OPERATORS, CRITERIA_UNITS, type CriteriaOperator, type CriteriaUnit, type EligibilityRule } from "@/lib/mca/funders/contracts"
import type { SessionResponse } from "@/lib/mca/types"

const FIELDS = [
  "revenue",
  "fico",
  "time_in_business",
  "positions",
  "requested_amount",
  "term",
  "average_daily_balance",
  "deposit_count",
  "nsf",
  "negative_days",
  "default_status",
  "entity",
  "state",
  "industry",
] as const

const fieldLabels: Record<(typeof FIELDS)[number], string> = {
  revenue: "Revenue",
  fico: "FICO",
  time_in_business: "Time in business",
  positions: "Positions",
  requested_amount: "Requested amount",
  term: "Term",
  average_daily_balance: "Average daily balance",
  deposit_count: "Deposit count",
  nsf: "NSF",
  negative_days: "Negative days",
  default_status: "Default status",
  entity: "Entity",
  state: "State",
  industry: "Industry",
}

const operatorLabels: Record<CriteriaOperator, string> = {
  min: "Min",
  max: "Max",
  eq: "Equals",
  in: "In",
  not_in: "Not in",
}

type CriteriaPayload = { funderId: string; criteriaVersion: number; publishedAt: string | null; rules: EligibilityRule[] }
type RuleDraft = {
  key: string
  id?: string
  field: (typeof FIELDS)[number]
  operator: CriteriaOperator
  unit: CriteriaUnit
  value: string
  sourceText: string
  unspecified: boolean
}

function emptyRule(): RuleDraft {
  return { key: crypto.randomUUID(), field: "revenue", operator: "min", unit: "usd_monthly", value: "", sourceText: "", unspecified: false }
}

function formatValue(value: EligibilityRule["value"]): string {
  if (value == null) return ""
  if (Array.isArray(value)) return value.join(", ")
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

function fromRule(rule: EligibilityRule): RuleDraft {
  return {
    key: rule.id,
    id: rule.id,
    field: FIELDS.includes(rule.field as (typeof FIELDS)[number]) ? rule.field as (typeof FIELDS)[number] : "revenue",
    operator: rule.operator,
    unit: rule.unit,
    value: formatValue(rule.value),
    sourceText: rule.sourceText ?? "",
    unspecified: rule.unspecified,
  }
}

function payloadValue(draft: RuleDraft): EligibilityRule["value"] {
  if (draft.unspecified) return null
  if (draft.operator === "in" || draft.operator === "not_in") {
    return draft.value.split(",").map((item) => item.trim()).filter(Boolean)
  }
  if (draft.unit === "boolean" || draft.value === "true" || draft.value === "false") return draft.value === "true"
  const numeric = Number(draft.value)
  return draft.value.trim() !== "" && Number.isFinite(numeric) ? numeric : draft.value
}

function yearlyToMonthly(value: string): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value
  return String(numeric / 12)
}

export function CriteriaPanel({ funderId }: { funderId: string }) {
  const [payload, setPayload] = React.useState<CriteriaPayload>()
  const [rules, setRules] = React.useState<RuleDraft[]>([])
  const [canManage, setCanManage] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({})

  const load = React.useCallback(async () => {
    setLoading(true); setError("")
    try {
      const [criteria, session] = await Promise.all([
        requestJson<CriteriaPayload>(`/api/mca/funders/criteria/${encodeURIComponent(funderId)}`),
        requestJson<SessionResponse>("/api/auth/session"),
      ])
      setPayload(criteria)
      setRules(criteria.rules.map(fromRule))
      setCanManage(Boolean(session.permissions?.canManageWorkspace))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Eligibility rules could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [funderId])

  React.useEffect(() => { void load() }, [load])

  function fail(caught: unknown, fallback: string) {
    if (caught instanceof RequestError) {
      setError(caught.message)
      setFieldErrors(caught.fieldErrors ?? {})
      return
    }
    setError(caught instanceof Error ? caught.message : fallback)
    setFieldErrors({})
  }

  async function publish(event: React.FormEvent) {
    event.preventDefault()
    if (!canManage) return
    setBusy(true); setError(""); setNotice(""); setFieldErrors({})
    try {
      const saved = await requestJson<CriteriaPayload>(`/api/mca/funders/criteria/${encodeURIComponent(funderId)}`, {
        method: "PUT",
        body: JSON.stringify({
          rules: rules.map((rule) => ({
            id: rule.id,
            field: rule.field,
            operator: rule.operator,
            unit: rule.unit,
            value: payloadValue(rule),
            sourceText: rule.sourceText || undefined,
            unspecified: rule.unspecified,
          })),
        }),
      })
      setPayload(saved)
      setRules(saved.rules.map(fromRule))
      setNotice("Eligibility rules published.")
      toast.success("Criteria saved")
    } catch (caught) {
      fail(caught, "The eligibility rules could not be published.")
    } finally {
      setBusy(false)
    }
  }

  function convertRule(key: string) {
    setRules((current) => current.map((rule) => {
      if (rule.key !== key || rule.field !== "revenue" || (rule.unit !== "usd_annual" && rule.unspecified)) return rule
      return { ...rule, unit: "usd_monthly", value: yearlyToMonthly(rule.value) }
    }))
  }

  if (loading) {
    return <Card><CardContent className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Loading eligibility rules…</CardContent></Card>
  }

  if (error && !payload) {
    return <Card><CardContent className="flex min-h-40 items-center gap-3 p-6"><AlertCircle className="size-5 text-destructive" /><div className="flex-1"><p className="font-medium">Eligibility rules unavailable</p><p className="text-sm text-muted-foreground">{error}</p></div><Button variant="outline" onClick={() => void load()}><RefreshCw />Retry</Button></CardContent></Card>
  }

  return <div className="space-y-4">
    {(error || notice) && <div className={`rounded-lg border p-4 text-sm ${error ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/30 bg-emerald-500/5"}`} role={error ? "alert" : "status"}>
      <div className="flex items-start gap-2">{error ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}<p>{error || notice}</p></div>
    </div>}

    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Eligibility rules {payload && <Badge variant="outline">v{payload.criteriaVersion}</Badge>}</CardTitle>
        <CardDescription>
          Typed thresholds with units. Unspecified stays empty — never a sentinel number. Yearly revenue converts to monthly at annual / 12.
          {payload?.publishedAt ? ` Last published ${new Date(payload.publishedAt).toLocaleString()}.` : " No rules published yet."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void publish(event)} className="space-y-4">
          {!rules.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No eligibility rules yet. Add revenue, FICO, industry, and other limits, or mark a field unspecified.</div> : rules.map((rule, index) => <div key={rule.key} className="space-y-3 rounded-lg border p-3">
            <div className="grid gap-2 lg:grid-cols-[1fr_8rem_9rem_1fr_auto]">
              <Select value={rule.field} disabled={!canManage} onValueChange={(field) => setRules((current) => current.map((item) => item.key === rule.key ? { ...item, field: field as (typeof FIELDS)[number] } : item))}>
                <SelectTrigger aria-label={`Rule ${index + 1} field`}><SelectValue /></SelectTrigger>
                <SelectContent>{FIELDS.map((field) => <SelectItem key={field} value={field}>{fieldLabels[field]}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={rule.operator} disabled={!canManage} onValueChange={(operator) => setRules((current) => current.map((item) => item.key === rule.key ? { ...item, operator: operator as CriteriaOperator } : item))}>
                <SelectTrigger aria-label={`Rule ${index + 1} operator`}><SelectValue /></SelectTrigger>
                <SelectContent>{CRITERIA_OPERATORS.map((operator) => <SelectItem key={operator} value={operator}>{operatorLabels[operator]}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={rule.unit} disabled={!canManage || rule.unspecified} onValueChange={(unit) => setRules((current) => current.map((item) => item.key === rule.key ? { ...item, unit: unit as CriteriaUnit } : item))}>
                <SelectTrigger aria-label={`Rule ${index + 1} unit`}><SelectValue /></SelectTrigger>
                <SelectContent>{CRITERIA_UNITS.map((unit) => <SelectItem key={unit} value={unit}>{unit.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
              </Select>
              <Input aria-label={`Rule ${index + 1} value`} value={rule.unspecified ? "" : rule.value} disabled={!canManage || rule.unspecified} placeholder={rule.operator === "in" || rule.operator === "not_in" ? "Comma-separated values" : "Value"} onChange={(event) => setRules((current) => current.map((item) => item.key === rule.key ? { ...item, value: event.target.value } : item))} />
              {canManage && <Button type="button" variant="ghost" size="icon" aria-label={`Remove rule ${index + 1}`} onClick={() => setRules((current) => current.filter((item) => item.key !== rule.key))}><Trash2 /></Button>}
            </div>
            <Input aria-label={`Rule ${index + 1} source`} value={rule.sourceText} disabled={!canManage} placeholder="Source text / policy date" onChange={(event) => setRules((current) => current.map((item) => item.key === rule.key ? { ...item, sourceText: event.target.value } : item))} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={rule.unspecified} disabled={!canManage} onCheckedChange={(unspecified) => setRules((current) => current.map((item) => item.key === rule.key ? { ...item, unspecified, value: unspecified ? "" : item.value } : item))} />
                Unspecified
              </label>
              {canManage && rule.field === "revenue" && rule.unit === "usd_annual" && !rule.unspecified && (
                <Button type="button" variant="outline" size="sm" onClick={() => convertRule(rule.key)}>Convert yearly to monthly</Button>
              )}
            </div>
            {fieldErrors[`rules.${index}`]?.[0] && <p className="text-xs text-destructive">{fieldErrors[`rules.${index}`][0]}</p>}
            {fieldErrors[`rules.${index}.value`]?.[0] && <p className="text-xs text-destructive">{fieldErrors[`rules.${index}.value`][0]}</p>}
          </div>)}
          {canManage ? <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setRules((current) => [...current, emptyRule()])}><Plus />Add rule</Button>
            <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : null}Publish rules</Button>
          </div> : <p className="text-sm text-muted-foreground">Only workspace admins can publish eligibility rules.</p>}
        </form>
      </CardContent>
    </Card>

  </div>
}
