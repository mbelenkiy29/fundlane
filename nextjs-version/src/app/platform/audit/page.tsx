import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PlatformHeading, PlatformSection } from "@/components/mca/platform/presentation"
import { platformAudit,platformQuerySchema } from "@/lib/mca/platform-console"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { listSuperAdminActions } from "@/lib/mca/platform-audit"
import { PlatformSearch,PlatformPagination } from "@/components/mca/platform/tables"
import { Table,TableHeader,TableHead,TableBody,TableRow,TableCell } from "@/components/ui/table"
import { AuditExport } from "./audit-export"
export default async function AuditPage({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}) {
  await requirePlatformPage()
  const params = await searchParams
  const query=platformQuerySchema.parse(params)
  const superAdmin = params.tab === "super-admin"
  const filters={actor:params.actor,action:params.action,workspace:params.workspace,from:params.from,to:params.to,offset:query.offset}
  const rows = superAdmin ? await listSuperAdminActions(filters) : await platformAudit(query)
  return <div className="min-w-0 space-y-6">
    <PlatformHeading title="Audit events" description="Review company activity and privileged operator actions." />
    <nav aria-label="Audit views" className="flex flex-wrap gap-2"><Button asChild variant={superAdmin ? "outline" : "default"}><Link aria-current={!superAdmin ? "page" : undefined} href="/platform/audit">Company actions</Link></Button><Button asChild variant={superAdmin ? "default" : "outline"}><Link aria-current={superAdmin ? "page" : undefined} href="/platform/audit?tab=super-admin">Super-admin actions</Link></Button></nav>
    {superAdmin ? <>
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border bg-muted/20 p-4"><input type="hidden" name="tab" value="super-admin"/><Label className="grid gap-2">Actor<Input name="actor" placeholder="Actor email" defaultValue={params.actor??""}/></Label><Label className="grid gap-2">Action<Input name="action" placeholder="Action" defaultValue={params.action??""}/></Label><Label className="grid gap-2">Company<Input name="workspace" placeholder="Company ID" defaultValue={params.workspace??""}/></Label><Label className="grid gap-2">From (UTC)<Input name="from" type="date" defaultValue={params.from??""}/></Label><Label className="grid gap-2">Through (UTC)<Input name="to" type="date" defaultValue={params.to??""}/></Label><Button type="submit">Filter</Button></form>
      <AuditExport filters={filters}/>
      <PlatformSection title="Super-admin actions">{!rows.length ? <p className="py-6 text-sm text-muted-foreground">No matching super-admin actions.</p> : <Table aria-label="Super-admin actions"><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Company</TableHead><TableHead>Target</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}><TableCell>{new Date(row.created_at).toLocaleString("en-US")}</TableCell><TableCell>{"actor_email" in row ? row.actor_email : row.actor_user_id}</TableCell><TableCell>{row.action}</TableCell><TableCell>{"target_workspace_id" in row ? row.target_workspace_id??"—" : row.company_name}</TableCell><TableCell>{"target_type" in row ? `${row.target_type??""}: ${row.target_id??""}` : `${row.resource_type}: ${row.resource_id}`}</TableCell><TableCell>{row.reason??"—"}</TableCell></TableRow>)}</TableBody></Table>}</PlatformSection>
    </> : <>
      <PlatformSearch query={query}/>
      <PlatformSection title="Company actions">{!rows.length?<p className="py-6 text-sm text-muted-foreground">No matching audit events.</p>:<Table aria-label="Company audit events"><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Company</TableHead><TableHead>Actor</TableHead><TableHead>Action / resource</TableHead><TableHead>Billing reason</TableHead></TableRow></TableHeader><TableBody>{rows.map(row=><TableRow key={row.id}><TableCell>{new Date(row.created_at).toLocaleString("en-US")}</TableCell><TableCell><Link className="font-medium underline-offset-4 hover:underline" href={`/platform/companies/${"workspace_id" in row ? row.workspace_id : row.target_workspace_id}`}>{"company_name" in row ? row.company_name : row.target_workspace_id}</Link></TableCell><TableCell className="text-xs">{row.actor_user_id??"System"}</TableCell><TableCell>{row.action}<div className="text-xs text-muted-foreground">{"resource_type" in row ? row.resource_type : row.target_type}: {"resource_id" in row ? row.resource_id : row.target_id}</div></TableCell><TableCell className="max-w-sm whitespace-normal">{row.reason??"—"}</TableCell></TableRow>)}</TableBody></Table>}</PlatformSection>
      <PlatformPagination query={query} count={rows.length}/>
    </>}
  </div>
}
