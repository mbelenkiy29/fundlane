import { FunderAnalytics } from "@/components/mca/reports/funder-analytics"
import { LeadRoi } from "@/components/mca/reports/lead-roi"
import { RepFunnel } from "@/components/mca/reports/rep-funnel"
import { TeamProfit } from "@/components/mca/reports/team-profit"
import { ApplicationOutreachReport } from "@/components/mca/applications/outreach-report"

export default function ReportsPage() {
  return (
    <div className="space-y-6 px-4 lg:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Rep, team, funder and lead reports load from verified workspace data. Incomplete periods stay labeled and permission-restricted views do not invent zeros.
        </p>
      </div>
      <ApplicationOutreachReport />
      <div id="mca-reports-rep-funnel">
        <RepFunnel />
      </div>
      <div id="mca-reports-team-profit">
        <TeamProfit />
      </div>
      <div id="mca-reports-funders">
        <FunderAnalytics />
      </div>
      <div id="mca-reports-lead-roi">
        <LeadRoi />
      </div>
    </div>
  )
}
