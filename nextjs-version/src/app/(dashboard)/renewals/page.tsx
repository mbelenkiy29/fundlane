import { RenewalsPanel } from "@/components/mca/accounting"

export default function RenewalsPage() {
  return <div className="space-y-6 px-4 lg:px-6"><div><h1 className="text-2xl font-semibold tracking-tight">Renewals</h1><p className="mt-1 text-sm text-muted-foreground">Track eligibility and follow up on each funded advance.</p></div><RenewalsPanel /></div>
}
