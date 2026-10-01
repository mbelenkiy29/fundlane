import Link from "next/link"
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
  return <div className="space-y-6">
    <h1 className="text-3xl font-bold">Audit events</h1>
    <nav className="flex gap-4"><Link className="underline" href="/platform/audit">Company actions</Link><Link className="underline" href="/platform/audit?tab=super-admin">Super-admin actions</Link></nav>
    {superAdmin ? <>
      <form method="get" className="flex flex-wrap gap-2"><input type="hidden" name="tab" value="super-admin"/><input name="actor" placeholder="Actor email" defaultValue={params.actor??""}/><input name="action" placeholder="Action" defaultValue={params.action??""}/><input name="workspace" placeholder="Company ID" defaultValue={params.workspace??""}/><input name="from" type="date" defaultValue={params.from??""}/><input name="to" type="date" defaultValue={params.to??""}/><button type="submit">Filter</button></form>
      <AuditExport filters={filters}/>
      {!rows.length ? <p>No matching super-admin actions.</p> : <Table><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Actor</TableHead><TableHead>Action</TableHead><TableHead>Company</TableHead><TableHead>Target</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.id}><TableCell>{new Date(row.created_at).toLocaleString("en-US")}</TableCell><TableCell>{"actor_email" in row ? row.actor_email : row.actor_user_id}</TableCell><TableCell>{row.action}</TableCell><TableCell>{"target_workspace_id" in row ? row.target_workspace_id??"—" : row.company_name}</TableCell><TableCell>{"target_type" in row ? `${row.target_type??""}: ${row.target_id??""}` : `${row.resource_type}: ${row.resource_id}`}</TableCell><TableCell>{row.reason??"—"}</TableCell></TableRow>)}</TableBody></Table>}
    </> : <>
      <PlatformSearch query={query}/>
      {!rows.length?<p>No matching audit events.</p>:<Table><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Company</TableHead><TableHead>Actor</TableHead><TableHead>Action / resource</TableHead><TableHead>Billing reason</TableHead></TableRow></TableHeader><TableBody>{rows.map(row=><TableRow key={row.id}><TableCell>{new Date(row.created_at).toLocaleString("en-US")}</TableCell><TableCell><Link className="underline" href={`/platform/companies/${"workspace_id" in row ? row.workspace_id : row.target_workspace_id}`}>{"company_name" in row ? row.company_name : row.target_workspace_id}</Link></TableCell><TableCell className="text-xs">{row.actor_user_id??"System"}</TableCell><TableCell>{row.action}<div className="text-xs text-muted-foreground">{"resource_type" in row ? row.resource_type : row.target_type}: {"resource_id" in row ? row.resource_id : row.target_id}</div></TableCell><TableCell className="max-w-sm whitespace-normal">{row.reason??"—"}</TableCell></TableRow>)}</TableBody></Table>}
      <PlatformPagination query={query} count={rows.length}/>
    </>}
  </div>
}
