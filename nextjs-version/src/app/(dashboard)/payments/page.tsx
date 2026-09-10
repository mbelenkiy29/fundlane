import { PaymentsPanel, SchedulesPanel } from "@/components/mca/accounting"

export default function PaymentsPage() {
  return (
    <div className="space-y-6 px-4 lg:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payments and commissions</h1>
        <p className="mt-1 text-sm text-muted-foreground">Reconcile expected revenue, collected amounts and recipient distributions.</p>
      </div>
      <PaymentsPanel />
      <SchedulesPanel />
    </div>
  )
}
