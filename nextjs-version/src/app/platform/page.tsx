import Link from "next/link"
import { CurrencyTotals } from "@/components/mca/platform/tables"
import { platformPayments } from "@/lib/mca/platform-console"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
export default async function PlatformPage(){await requirePlatformPage();const {totals}=await platformPayments({q:"",status:"",offset:0});return <div className="space-y-8"><header><h1 className="text-3xl font-bold">Platform overview</h1><p className="mt-2 text-muted-foreground">Company access, subscription collection and operational audit.</p></header><div className="flex flex-wrap gap-4"><Link className="underline" href="/platform/companies">Manage company access</Link><Link className="underline" href="/platform/payments">Review invoices and payments</Link><Link className="underline" href="/platform/audit">Search audit events</Link></div><CurrencyTotals totals={totals}/></div>}
