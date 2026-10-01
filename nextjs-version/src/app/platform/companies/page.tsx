import Link from "next/link"
import { platformCompanies, platformQuerySchema, listBillingStateExceptions } from "@/lib/mca/platform-console"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { PlatformSearch, PlatformPagination } from "@/components/mca/platform/tables"
import { PlatformHeading, PlatformSection, PlatformStatus } from "@/components/mca/platform/presentation"
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table"

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePlatformPage()
  const query = platformQuerySchema.parse(await searchParams)
  const [rows, exceptions] = await Promise.all([platformCompanies(query), listBillingStateExceptions()])
  return <div className="min-w-0 space-y-6">
    <PlatformHeading title="Companies" description="Review company access, subscriptions and seat usage." />
    <PlatformSection title={`Billing state exceptions (${exceptions.length})`} description="Review each missing state or explicit exemption before choosing a resolution.">
      {exceptions.length ? <ul className="divide-y">{exceptions.map(row => <li className="flex flex-wrap items-center justify-between gap-2 py-3" key={row.id}><Link className="font-medium underline-offset-4 hover:underline" href={`/platform/companies/${row.id}`}>{row.name}</Link><PlatformStatus value={row.legacyExempt ? `Legacy exempt (${row.stateKind ?? "historical"})` : "Missing billing state"} /></li>)}</ul> : <p className="text-sm text-muted-foreground">No billing state exceptions.</p>}
    </PlatformSection>
    <PlatformSection title="Company directory" description="Filter by current access, subscription status or explicit override. Current access includes trial and grace expiration.">
      <PlatformSearch query={query} statuses={["access:trial", "access:active", "access:grace", "access:paused", "access:extended", "missing_state", "no_subscription", "active", "past_due", "unpaid", "canceled", "incomplete", "legacy_exempt", "manual_paused"]} />
      {rows.length === 0 ? <p className="py-6 text-sm text-muted-foreground">No matching companies.</p> : <Table aria-label="Company directory"><TableHeader><TableRow><TableHead>Company</TableHead><TableHead>Billing state</TableHead><TableHead>Access</TableHead><TableHead>Subscription</TableHead><TableHead>Selected / purchased</TableHead><TableHead>Reserved / limit</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}><TableCell><Link className="font-medium underline-offset-4 hover:underline" href={`/platform/companies/${row.id}`}>{row.name}</Link></TableCell><TableCell><PlatformStatus value={row.billingState} /></TableCell><TableCell><PlatformStatus value={row.access.status} /><div className="mt-1 text-xs text-muted-foreground">{row.access.reason?.replaceAll("_", " ")}</div></TableCell><TableCell><PlatformStatus value={row.subscriptionStatus} /></TableCell><TableCell className="tabular-nums">{row.selectedSeats} / {row.purchasedSeats}</TableCell><TableCell className="tabular-nums">{row.occupiedSeats} / {row.access.seatLimit}</TableCell></TableRow>)}</TableBody></Table>}
      <PlatformPagination query={query} count={rows.length} />
    </PlatformSection>
  </div>
}
