import { listDemoSubmissions, hasUnnotifiedDemoSubmissions } from "@/lib/marketing/demo-storage"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "@/components/ui/table"

export default async function DemoRequestsPage() {
  await requirePlatformPage()
  const [rows, unnotified] = await Promise.all([listDemoSubmissions(), hasUnnotifiedDemoSubmissions()])
  return <div className="space-y-6"><header className="space-y-2"><h1 className="text-3xl font-bold">Demo requests</h1>{unnotified && <p role="status" className="rounded border border-amber-500 bg-amber-50 p-3 font-semibold text-amber-900">Warning: one or more demo requests have unknown or unsent notification status. Review the list; retry only tracked unsent requests.</p>}</header>{rows.length === 0 ? <p>No demo requests.</p> : <Table><TableHeader><TableRow><TableHead>Received</TableHead><TableHead>Brokerage</TableHead><TableHead>Contact</TableHead><TableHead>Team size</TableHead><TableHead>Message</TableHead><TableHead>Notification</TableHead></TableRow></TableHeader><TableBody>{rows.map(row => <TableRow key={row.request_id}><TableCell>{new Date(row.created_at).toLocaleString("en-US")}</TableCell><TableCell>{row.contact.brokerage}</TableCell><TableCell>{row.contact.name}<div><a className="underline" href={`mailto:${row.contact.email}`}>{row.contact.email}</a></div></TableCell><TableCell>{row.contact.teamSize}</TableCell><TableCell className="max-w-sm whitespace-normal">{row.contact.message || "—"}</TableCell><TableCell>{row.notification_status}<div className="text-xs text-muted-foreground">{row.notification_attempts} attempts</div></TableCell></TableRow>)}</TableBody></Table>}</div>
}
