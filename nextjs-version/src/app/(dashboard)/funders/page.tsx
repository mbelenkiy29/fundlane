import { FunderDirectoryPanel } from "@/components/mca/funders/funder-directory-panel"

export default function FundersPage() {
  return (
    <div className="px-4 lg:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Funders</h1>
        <p className="mt-1 text-sm text-muted-foreground">Funder contacts, products, groups, routing, bulk import, and guideline PDF criteria for this workspace.</p>
      </div>
      <FunderDirectoryPanel />
    </div>
  )
}
