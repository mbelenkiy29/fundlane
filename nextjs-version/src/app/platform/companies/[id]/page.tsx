import { notFound } from "next/navigation"
import { platformCompany,platformPayments,platformQuerySchema } from "@/lib/mca/platform-console"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { AppError } from "@/lib/mca/errors"
import { InvoiceTable,PaymentTable,AdjustmentTable,CurrencyTotals,PlatformSearch,PlatformPagination } from "@/components/mca/platform/tables"
import { CompanyControls } from "@/components/mca/platform/company-controls"
import { formatBillingMoney } from "@/lib/mca/billing-display"
export default async function CompanyPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|undefined>>}) {
  await requirePlatformPage();const {id}=await params
  const data=await platformCompany(id).catch(error=>{if(error instanceof AppError&&error.status===404)notFound();throw error})
  const query=platformQuerySchema.parse(await searchParams),financial=await platformPayments(query,id)
  return <div className="space-y-8"><header><h1 className="text-3xl font-bold">{data.company.name}</h1><p className="mt-2 text-sm text-muted-foreground">{id}</p></header>
    <section className="grid gap-3 rounded-lg border p-5 sm:grid-cols-2"><p>Access: <strong>{data.access.status.replaceAll("_"," ")}</strong></p><p>Invitation limit: {data.access.seatLimit}</p><p>Owner: {data.owner?.email??"Not assigned"}</p><p>Plan: {data.subscription?.planName??"No paid subscription"}</p><p>Current catalog version: <span className="break-all">{data.pricing.version}</span></p><p>Purchased plan price: {data.pricing.purchasedMonthlyCents===null?"No current-catalog price verified":`${formatBillingMoney(data.pricing.purchasedMonthlyCents)} USD/month`}</p><p>Selected paid seats: {data.state?.selectedSeats??"Not selected"} · {formatBillingMoney(data.pricing.selectedMonthlyCents)} USD/month</p><p>Trial ends: {data.access.trialEndsAt??"No trial"}</p><p>Grace ends: {data.access.graceEndsAt??"No grace period"}</p><p>Pending seats: {data.state?.pendingSeats??"None"} {data.state?.pendingSeatsAt}</p><p>Extension: {data.state?.accessExtendedUntil||"None"}</p>{data.access.reason&&<p>Access reason: {data.access.reason.replaceAll("_"," ")}</p>}</section>
    <CompanyControls id={id} paused={data.access.manualPaused} owner={data.owner} ownerCandidates={data.ownerCandidates} notifications={data.notifications}/><PlatformSearch financial query={query} statuses={["draft","open","paid","void","uncollectible"]}/><CurrencyTotals totals={financial.totals} query={query} companyScoped/><InvoiceTable rows={financial.invoices}/><PaymentTable rows={financial.payments}/><AdjustmentTable rows={financial.adjustments}/><PlatformPagination query={query} count={Math.max(financial.invoices.length,financial.payments.length,financial.adjustments.length)}/>
  </div>
}
