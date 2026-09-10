import { FileCheck2, LockKeyhole, ShieldCheck } from "lucide-react"
import { hashOpaqueToken } from "@/lib/mca/crypto"
import { resolveAttributionToken } from "@/lib/mca/intake/repository"

interface PageProps {
  params: Promise<{ formId: string }>
  searchParams: Promise<{ mca_rep?: string | string[] }>
}

export default async function SharedApplicationPage({ params, searchParams }: PageProps) {
  const { formId } = await params
  const raw = (await searchParams).mca_rep
  const token = typeof raw === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(raw) ? raw : undefined
  const attribution = token ? await resolveAttributionToken(hashOpaqueToken(token)) : undefined
  const valid = attribution?.formId === formId
  const formUrl = valid ? `https://form.jotform.com/${encodeURIComponent(formId)}?mca_rep=${encodeURIComponent(token!)}` : undefined

  return <main className="min-h-screen bg-muted/30 px-4 py-10">
    <div className="mx-auto max-w-5xl">
      <div className="mb-8 flex items-start gap-3">
        <div className="rounded-xl bg-primary p-2.5 text-primary-foreground"><FileCheck2 className="size-5" /></div>
        <div><h1 className="text-2xl font-semibold tracking-tight">Business funding application</h1><p className="mt-1 text-sm text-muted-foreground">Your secure team link keeps this application assigned to the right representative.</p></div>
      </div>
      {!valid ? <div className="rounded-xl border border-destructive/30 bg-card p-6" role="alert">
        <div className="flex items-center gap-2 font-medium text-destructive"><LockKeyhole className="size-5" />This application link is invalid or no longer active</div>
        <p className="mt-2 text-sm text-muted-foreground">Ask your representative for a new personal link. No application data was accepted.</p>
      </div> : <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <iframe title="Business funding application" src={formUrl} className="min-h-[820px] w-full" allow="geolocation 'none'; camera 'none'; microphone 'none'" />
        </div>
        <aside className="h-fit rounded-xl border bg-card p-5">
          <div className="flex items-center gap-2 font-medium"><ShieldCheck className="size-4 text-emerald-600" />Before you submit</div>
          <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
            <li>Upload every required recent bank statement.</li>
            <li>Select states from the form list; do not enter abbreviations in free text.</li>
            <li>Check EIN, phone, date, and owner identity last-four formats.</li>
            <li>Never enter a full Social Security number unless the form explicitly requires and protects it.</li>
          </ul>
        </aside>
      </div>}
    </div>
  </main>
}
