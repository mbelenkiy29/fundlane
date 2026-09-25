import Link from "next/link"
import { Logo } from "@/components/logo"

export function AuthShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <main className="grid min-h-svh bg-muted/40 lg:grid-cols-[minmax(0,1fr)_minmax(440px,0.72fr)]">
    <section className="relative hidden overflow-hidden bg-zinc-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
      <div className="absolute inset-0 opacity-40 [background-image:radial-gradient(circle_at_20%_15%,oklch(0.62_0.17_155/.55),transparent_30%),linear-gradient(135deg,transparent_35%,oklch(0.24_0.03_155/.7))]" />
      <Link href="/" className="relative z-10 flex items-center gap-3 text-sm font-semibold"><span className="flex size-9 items-center justify-center rounded-lg bg-white text-zinc-950"><Logo size={25} aria-hidden="true" /></span>Fundlane</Link>
      <div className="relative z-10 max-w-lg"><p className="text-4xl font-semibold leading-tight tracking-tight">Move every deal forward with a clear owner and a complete record.</p><p className="mt-5 max-w-md text-sm leading-6 text-zinc-300">A secure operating workspace for brokerage teams, from intake through funding.</p></div>
      <p className="relative z-10 text-xs text-zinc-400">Workspace data is isolated and every configuration change is audited.</p>
    </section>
    <section className="flex items-center justify-center p-5 sm:p-10"><div className="w-full max-w-md"><Link href="/" className="mb-10 flex items-center gap-2 font-semibold lg:hidden"><span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Logo size={24} aria-hidden="true" /></span>Fundlane</Link><div className="mb-7"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p></div>{children}</div></section>
  </main>
}
