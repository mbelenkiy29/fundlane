import { platformPayments, platformQuerySchema } from "@/lib/mca/platform-console"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { CurrencyTotals, BillingObservations, InvoiceTable, PaymentTable, AdjustmentTable, PlatformSearch, PlatformPagination } from "@/components/mca/platform/tables"
import { PlatformHeading } from "@/components/mca/platform/presentation"

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePlatformPage()
  const query = platformQuerySchema.parse(await searchParams), data = await platformPayments(query)
  return <div className="min-w-0 space-y-6">
    <PlatformHeading snapshotAt={data.snapshotAt} title="Invoices, payments & adjustments" description="Review subscription collection and provider financial records." />
    <PlatformSearch financial query={query} statuses={["draft", "open", "paid", "void", "uncollectible"]} />
    <BillingObservations rows={data.billingObservations} snapshotAt={data.snapshotAt} truncated={data.observationsTruncated} />
    <CurrencyTotals totals={data.totals} query={query} />
    <InvoiceTable rows={data.invoices} /><PaymentTable rows={data.payments} /><AdjustmentTable rows={data.adjustments} />
    <PlatformPagination query={query} count={Math.max(data.invoices.length, data.payments.length, data.adjustments.length)} />
  </div>
}
