import Link from "next/link"
import { OperationsQueues } from "@/components/mca/platform/operations-queues"
import { PlatformHeading, PlatformSection, PlatformStatus } from "@/components/mca/platform/presentation"
import { Button } from "@/components/ui/button"
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table"
import { notFound } from "next/navigation"
import { platformCompany, platformPayments, platformQuerySchema } from "@/lib/mca/platform-console"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { AppError } from "@/lib/mca/errors"
import { BillingObservations, InvoiceTable, PaymentTable, AdjustmentTable, CurrencyTotals, PlatformSearch, PlatformPagination } from "@/components/mca/platform/tables"
import { CompanyControls } from "@/components/mca/platform/company-controls"
import { formatBillingMoney } from "@/lib/mca/billing-display"

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePlatformPage()
  const { id } = await params
  const data = await platformCompany(id).catch(error => { if (error instanceof AppError && error.status === 404) notFound(); throw error })
  const query = platformQuerySchema.parse(await searchParams), financial = await platformPayments(query, id)
  return <div className="min-w-0 space-y-6">
    <PlatformHeading snapshotAt={financial.snapshotAt} title={data.company.name}><Button asChild variant="outline" size="sm"><Link href="/platform/companies">Back to companies</Link></Button></PlatformHeading>
    <p className="break-all font-mono text-xs text-muted-foreground">{id}</p>
    <PlatformSection title="Company summary">
      <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">{[
        ["Access", <PlatformStatus key="access" value={data.access.status} />],
        ["Invitation limit", data.access.seatLimit],
        ["Owner", data.owner?.email ?? "Not assigned"],
        ["Plan", data.subscription?.planName ?? "No paid subscription"],
        ["Current catalog version", data.pricing.version],
        ["Purchased plan price", data.pricing.purchasedMonthlyCents === null ? "No current-catalog price verified" : `${formatBillingMoney(data.pricing.purchasedMonthlyCents)} USD/month`],
        ["Selected paid seats", `${data.state?.selectedSeats ?? "Not selected"} · ${formatBillingMoney(data.pricing.selectedMonthlyCents)} USD/month`],
        ["Trial ends", data.access.trialEndsAt ?? "No trial"],
        ["Grace ends", data.access.graceEndsAt ?? "No grace period"],
        ["Pending seats", `${data.state?.pendingSeats ?? "None"} ${data.state?.pendingSeatsAt ?? ""}`],
        ["Extension", data.state?.accessExtendedUntil || "None"],
        ["Billing state", data.billingState ? `${data.billingState.kind}${data.billingState.legacyExempt ? " (exempt)" : ""}` : "MISSING — decision required"],
        ...(data.access.reason ? [["Access reason", data.access.reason.replaceAll("_", " ")]] : []),
      ].map(([label, value]) => <div key={String(label)} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-medium">{value}</dd></div>)}</dl>
    </PlatformSection>
    <PlatformSection title="Company members" description={`${data.seats.occupied} occupied seats / ${data.seats.purchased} purchased seats. Active members and pending invitations occupy seats.`}>
      {data.membershipsTruncated && <p className="text-sm text-muted-foreground">Showing the first 100 memberships by ID. Seat totals include all memberships.</p>}
      {data.memberships.length ? <Table aria-label="Company memberships"><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{data.memberships.map(member => <TableRow key={member.membershipId}><TableCell className="font-medium">{member.name}<div className="font-mono text-xs font-normal text-muted-foreground">{member.membershipId}</div></TableCell><TableCell>{member.email}</TableCell><TableCell><PlatformStatus value={member.role} /></TableCell><TableCell><PlatformStatus value={member.status} /></TableCell></TableRow>)}</TableBody></Table> : <p className="py-6 text-sm text-muted-foreground">No company memberships.</p>}
    </PlatformSection>
    <OperationsQueues workspaceId={id} />
    <OperationsQueues kind="sms" workspaceId={id} />
    <CompanyControls id={id} paused={data.access.manualPaused} billingState={data.billingState} owner={data.owner} ownerCandidates={data.ownerCandidates} notifications={data.notifications} />
    <PlatformSection title="Financial record filters"><PlatformSearch financial query={query} statuses={["draft", "open", "paid", "void", "uncollectible"]} /></PlatformSection>
    <BillingObservations rows={financial.billingObservations} snapshotAt={financial.snapshotAt} truncated={financial.observationsTruncated} />
    <CurrencyTotals totals={financial.totals} query={query} companyScoped />
    <InvoiceTable rows={financial.invoices} />
    <PaymentTable rows={financial.payments} />
    <AdjustmentTable rows={financial.adjustments} />
    <PlatformPagination query={query} count={Math.max(financial.invoices.length, financial.payments.length, financial.adjustments.length)} />
  </div>
}
