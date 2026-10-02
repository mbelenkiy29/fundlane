import Link from "next/link"
import { ArrowUpRight, Building2, ClipboardList, WalletCards } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { OperationsQueues } from "@/components/mca/platform/operations-queues"
import { CurrencyTotals, BillingObservations } from "@/components/mca/platform/tables"
import { PlatformHeading } from "@/components/mca/platform/presentation"
import { platformPayments } from "@/lib/mca/platform-console"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"

export default async function PlatformPage() {
  await requirePlatformPage()
  const data = await platformPayments({ q: "", status: "", offset: 0 })
  return <div className="min-w-0 space-y-6">
    <PlatformHeading snapshotAt={data.snapshotAt} title="Platform overview" description="Company access, subscription collection and operational audit." />
    <div className="grid gap-4 md:grid-cols-3">{[
      { href: "/platform/companies", title: "Manage companies", description: "Review access, seats and billing state.", icon: Building2 },
      { href: "/platform/payments", title: "Review payments", description: "Explore invoices and provider adjustments.", icon: WalletCards },
      { href: "/platform/audit", title: "Search audit events", description: "Trace company and operator actions.", icon: ClipboardList },
    ].map(action => <Link key={action.href} href={action.href} className="group rounded-xl outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"><Card className="h-full transition-colors group-hover:border-primary/50 group-hover:bg-muted/30"><CardContent className="space-y-4"><div className="flex items-center justify-between"><span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"><action.icon className="size-5" /></span><ArrowUpRight aria-hidden="true" className="size-4 text-muted-foreground" /></div><div className="space-y-1"><h2 className="font-semibold">{action.title}</h2><p className="text-sm text-muted-foreground">{action.description}</p></div></CardContent></Card></Link>)}</div>
    <BillingObservations rows={data.billingObservations} snapshotAt={data.snapshotAt} truncated={data.observationsTruncated} />
    <CurrencyTotals totals={data.totals} cards />
    <OperationsQueues />
  </div>
}
