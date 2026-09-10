import { AdvancesPanel } from "@/components/mca/accounting"

export default function AdvancesPage() {
  return <div className="space-y-6 px-4 lg:px-6"><div><h1 className="text-2xl font-semibold tracking-tight">Advances</h1><p className="mt-1 text-sm text-muted-foreground">Review funding history, scheduled progress and performance.</p></div><AdvancesPanel /></div>
}
