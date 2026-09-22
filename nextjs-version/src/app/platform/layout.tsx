import Link from "next/link"
import { requirePlatformPage } from "@/lib/mca/platform-page-access"
export const dynamic="force-dynamic"
export default async function PlatformLayout({children}:{children:React.ReactNode}) {
  await requirePlatformPage()
  return <div className="mx-auto max-w-7xl space-y-8 px-4 py-8 lg:px-6"><header className="space-y-4"><p className="text-lg font-semibold">Fundlane · Platform administration</p><nav aria-label="Platform" className="flex flex-wrap gap-5 text-sm">{[["/platform","Overview"],["/platform/companies","Companies"],["/platform/payments","Payments"],["/platform/audit","Audit"],["/account-security","Account security"]].map(([href,label])=><Link className="underline underline-offset-4" key={href} href={href}>{label}</Link>)}</nav></header><main>{children}</main></div>
}
