import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Check, Minus } from "lucide-react"

const rows = [
  ["Assigned deals", true, true, true, true],
  ["Managed reps’ deals", false, true, true, true],
  ["All workspace deals", false, false, true, true],
  ["Reports and company totals", false, false, true, true],
  ["Payment table", false, false, true, true],
  ["Manage team", false, false, true, true],
  ["Manage brokerage settings", false, false, false, true],
  ["Manage API keys", false, false, true, true],
] as const

export default function AccessPage() {
  return <div className="space-y-5">
    <div><h2 className="text-lg font-semibold">Roles and financial access</h2><p className="text-sm text-muted-foreground">A user’s role sets the maximum access. Workspace controls can narrow it further.</p></div>
    <Card><CardHeader><CardTitle>Role matrix</CardTitle><CardDescription>Originator and closer are deal assignments. They do not grant additional permissions.</CardDescription></CardHeader><CardContent className="p-0"><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead className="min-w-56">Capability</TableHead><TableHead>Rep</TableHead><TableHead>Manager</TableHead><TableHead>Admin</TableHead><TableHead>Super admin</TableHead></TableRow></TableHeader><TableBody>{rows.map(([label, ...values]) => <TableRow key={label}><TableCell className="font-medium">{label}</TableCell>{values.map((allowed, index) => <TableCell key={index}>{allowed ? <span className="inline-flex items-center gap-1 text-primary"><Check className="size-4" /><span className="sr-only">Allowed</span></span> : <span className="text-muted-foreground"><Minus className="size-4" /><span className="sr-only">Not allowed</span></span>}</TableCell>)}</TableRow>)}</TableBody></Table></div></CardContent></Card>
    <div className="grid gap-4 md:grid-cols-2"><Card><CardHeader><CardTitle className="text-base">Deal visibility</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><p><Badge variant="secondary">Rep</Badge> sees deals where they are an assigned originator or closer.</p><p><Badge variant="secondary">Manager</Badge> also sees deals assigned to reps who currently report to them.</p><p><Badge variant="secondary">Admin</Badge> and <Badge variant="secondary">Super admin</Badge> see all workspace deals.</p></CardContent></Card><Card><CardHeader><CardTitle className="text-base">Financial visibility</CardTitle></CardHeader><CardContent className="space-y-3 text-sm text-muted-foreground"><p>Payments page access and payment table access are enforced separately. A visible Payments page does not reveal the table unless the role and workspace action control both allow it.</p><p>Exports and API responses use the same server policy as the screen.</p></CardContent></Card></div>
  </div>
}
