import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table"
import { PlatformSection, PlatformStatus } from "./presentation"
import { formatBillingMoney } from "@/lib/mca/billing-display"
import type { Invoice, Payment, Adjustment, CurrencyTotal, PlatformQuery } from "@/lib/mca/platform-console"
import { billingObservationStatus, type BillingObservation } from "@/lib/mca/platform-refresh"

export function BillingObservations({ rows, snapshotAt, truncated = false }: { rows: BillingObservation[]; snapshotAt: string; truncated?: boolean }) {
  return <PlatformSection title="Stripe verification" description="Database refresh does not refresh Stripe. Signed webhooks reconcile promptly; maintenance retries every ten minutes. Verification older than 15 minutes is stale.">
    <p className="text-xs text-muted-foreground">Database snapshot: <time dateTime={snapshotAt}>{snapshotAt}</time></p>
    {truncated && <p>Showing the first 100 companies. Open a company to inspect its verification.</p>}
    {!rows.length ? <p>No companies connected.</p> : <Table aria-label="Stripe verification"><TableHeader><TableRow><TableHead>Company</TableHead><TableHead>Mode</TableHead><TableHead>Verification</TableHead><TableHead>Last successful Stripe read</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.workspaceId}><TableCell><Link href={`/platform/companies/${row.workspaceId}`}>{row.companyName}</Link></TableCell><TableCell>{row.livemode === null ? "Not connected" : row.livemode ? "Live" : "Test"}</TableCell><TableCell><PlatformStatus value={billingObservationStatus(row, Date.parse(snapshotAt))} /></TableCell><TableCell>{["stripe_api", "sync_engine"].includes(row.source ?? "") ? row.syncedAt ?? "Unavailable" : "Unverified"}</TableCell></TableRow>)}</TableBody></Table>}
  </PlatformSection>
}

export function PlatformSearch({ query, statuses = [], financial = false }: { query: PlatformQuery; statuses?: string[]; financial?: boolean }) {
  return <form className="flex flex-wrap items-end gap-3 rounded-xl border bg-muted/20 p-4">
    <Label className="grid min-w-0 flex-1 gap-2 sm:min-w-60">Search<Input name="q" defaultValue={query.q} placeholder="Company, owner email or identifier" maxLength={200} /></Label>
    {statuses.length > 0 && <Label className="grid gap-2">Status<select name="status" defaultValue={query.status} className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-ring"><option value="">All statuses</option>{statuses.map(status => <option key={status} value={status}>{status.replaceAll("_", " ").replace("access:", "Access: ")}</option>)}</select></Label>}
    {financial && <><Label className="grid gap-2">Currency<Input className="w-36" name="currency" defaultValue={query.currency ?? ""} placeholder="All (e.g. USD)" pattern="[A-Za-z]{3}" maxLength={3} /></Label><Label className="grid gap-2">From (UTC)<Input type="date" name="from" defaultValue={query.from ?? ""} /></Label><Label className="grid gap-2">Through (UTC)<Input type="date" name="to" defaultValue={query.to ?? ""} /></Label></>}
    <Button type="submit">Search</Button>
  </form>
}

export function PlatformPagination({ query, count }: { query: PlatformQuery; count: number }) {
  const url = (offset: number) => `?${new URLSearchParams({ q: query.q, status: query.status, offset: String(offset), currency: query.currency ?? "", from: query.from ?? "", to: query.to ?? "" })}`
  return <nav aria-label="Results pages" className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-sm"><span className="text-muted-foreground">Page {Math.floor(query.offset / 50) + 1} · Up to 50 records per list</span><div className="flex gap-2">{query.offset > 0 && <Button asChild size="sm" variant="outline"><Link href={url(Math.max(0, query.offset - 50))}>Previous</Link></Button>}{count === 50 && <Button asChild size="sm" variant="outline"><Link href={url(query.offset + 50)}>Next</Link></Button>}</div></nav>
}

export function CurrencyTotals({ totals, query, companyScoped = false, cards = false }: { totals: CurrencyTotal[]; query?: PlatformQuery; companyScoped?: boolean; cards?: boolean }) {
  const description = `${query?.from || query?.to ? `${query.from || "Beginning"} through ${query.to || "present"} (UTC).` : "All time."} ${companyScoped ? "This company only" : "All matching companies"}; search, currency and date filters apply across all pages. Invoice status applies to invoices and linked payments; adjustments are independent of invoice status. Gross collected uses invoice paid date (creation date when unavailable). Invoiced and outstanding use invoice creation date; outstanding includes open invoices only. Refunds and disputes use their creation date. These are separate categories, not net revenue.`
  return <PlatformSection title="Accounting totals by currency" description={description}>
    {totals.length === 0 ? <p className="py-6 text-sm text-muted-foreground">No financial records in this range.</p> : cards ? <div className="space-y-5">{totals.map(total => <section key={total.currency} className="space-y-3"><h3 className="text-sm font-semibold">{total.currency.toUpperCase()}</h3><dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[
      ["Invoiced", total.due], ["Gross collected", total.paid], ["Successful refunds", total.refunded], ["Outstanding (open)", total.remaining], ["Disputes (all statuses)", total.disputed],
    ].map(([label, amount]) => <div key={label} className="min-w-0 rounded-lg border bg-muted/20 p-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 break-words text-xl font-semibold tracking-tight tabular-nums">{formatBillingMoney(amount, total.currency)}</dd></div>)}</dl></section>)}</div> : <Table aria-label="Accounting totals by currency"><TableHeader><TableRow><TableHead>Currency</TableHead><TableHead>Invoiced</TableHead><TableHead>Gross collected</TableHead><TableHead>Successful refunds</TableHead><TableHead>Outstanding (open)</TableHead><TableHead>Disputes (all statuses)</TableHead></TableRow></TableHeader><TableBody>{totals.map(total => <TableRow key={total.currency}><TableCell className="font-medium">{total.currency.toUpperCase()}</TableCell>{[total.due, total.paid, total.refunded, total.remaining, total.disputed].map((amount, index) => <TableCell className="tabular-nums" key={index}>{formatBillingMoney(amount, total.currency)}</TableCell>)}</TableRow>)}</TableBody></Table>}
  </PlatformSection>
}

export function AdjustmentTable({ rows }: { rows: Adjustment[] }) {
  return <PlatformSection title="Refunds & disputes" description="Observed provider adjustments; invoice-status filters do not apply. Pending/failed refunds are not included in successful-refund totals.">
    {!rows.length ? <p className="py-6 text-sm text-muted-foreground">No matching refunds or disputes.</p> : <Table aria-label="Refunds and disputes"><TableHeader><TableRow><TableHead>Company / adjustment</TableHead><TableHead>Kind</TableHead><TableHead>Status</TableHead><TableHead>Amount</TableHead><TableHead>Reason</TableHead><TableHead>Mode / created</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}><TableCell><Link className="font-medium underline-offset-4 hover:underline" href={`/platform/companies/${row.workspace_id}`}>{row.company_name}</Link><div className="text-xs text-muted-foreground">{row.id}</div></TableCell><TableCell>{row.kind}</TableCell><TableCell><PlatformStatus value={row.status} /></TableCell><TableCell className="tabular-nums">{formatBillingMoney(row.amount, row.currency)}</TableCell><TableCell>{row.reason ?? "—"}</TableCell><TableCell>{row.livemode ? "Live" : "Test"} · {new Date(row.created_at).toLocaleDateString("en-US")}</TableCell></TableRow>)}</TableBody></Table>}
  </PlatformSection>
}

export function InvoiceTable({ rows }: { rows: Invoice[] }) {
  return <PlatformSection title="Invoices">
    {!rows.length ? <p className="py-6 text-sm text-muted-foreground">No matching invoices.</p> : <Table aria-label="Invoices"><TableHeader><TableRow><TableHead>Company / invoice</TableHead><TableHead>Status</TableHead><TableHead>Due</TableHead><TableHead>Paid</TableHead><TableHead>Remaining</TableHead><TableHead>Created</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.stripe_invoice_id}><TableCell><Link className="font-medium underline-offset-4 hover:underline" href={`/platform/companies/${row.workspace_id}`}>{row.company_name}</Link><div className="text-xs text-muted-foreground">{row.invoice_url ? <a href={row.invoice_url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{row.stripe_invoice_id} ↗</a> : row.stripe_invoice_id}</div></TableCell><TableCell><PlatformStatus value={row.status} /></TableCell><TableCell className="tabular-nums">{formatBillingMoney(row.amount_due, row.currency)}</TableCell><TableCell className="tabular-nums">{formatBillingMoney(row.amount_paid, row.currency)}</TableCell><TableCell className="tabular-nums">{formatBillingMoney(row.amount_remaining, row.currency)}</TableCell><TableCell>{new Date(row.created_at).toLocaleDateString("en-US")}</TableCell></TableRow>)}</TableBody></Table>}
  </PlatformSection>
}

export function PaymentTable({ rows }: { rows: Payment[] }) {
  return <PlatformSection title="Payments" description="Observed payment records; invoice status filters apply to the linked invoice.">
    {!rows.length ? <p className="py-6 text-sm text-muted-foreground">No matching payments.</p> : <Table aria-label="Payments"><TableHeader><TableRow><TableHead>Company</TableHead><TableHead>Payment / invoice</TableHead><TableHead>Status</TableHead><TableHead>Paid</TableHead><TableHead>Last synced</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.stripe_payment_id}><TableCell><Link className="font-medium underline-offset-4 hover:underline" href={`/platform/companies/${row.workspace_id}`}>{row.company_name}</Link></TableCell><TableCell className="font-mono text-xs">{row.stripe_payment_id}<br />{row.stripe_invoice_id}</TableCell><TableCell><PlatformStatus value={row.status} /></TableCell><TableCell className="tabular-nums">{formatBillingMoney(row.amount_paid, row.currency)}</TableCell><TableCell>{new Date(row.synced_at).toLocaleString("en-US")}</TableCell></TableRow>)}</TableBody></Table>}
  </PlatformSection>
}
