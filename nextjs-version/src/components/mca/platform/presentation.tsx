import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"

export function PlatformHeading({ title, description, children, snapshotAt }: { title: string; description?: string; children?: ReactNode; snapshotAt?: string }) {
  return <header className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 space-y-2"><h1 className="break-words text-2xl font-bold tracking-tight">{title}</h1>{description && <p className="text-sm text-muted-foreground">{description}</p>}{snapshotAt && <p className="text-xs text-muted-foreground">Database snapshot: <time dateTime={snapshotAt}>{snapshotAt}</time>. Updates every 30 seconds while visible.</p>}</div>{children}</header>
}

export function PlatformSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="min-w-0"><Card><CardHeader><h2 className="font-semibold leading-none">{title}</h2>{description && <CardDescription>{description}</CardDescription>}</CardHeader><CardContent className="min-w-0 space-y-4">{children}</CardContent></Card></section>
}

export function PlatformStatus({ value }: { value: string }) {
  return <Badge variant="outline" className="font-normal">{value.replaceAll("_", " ")}</Badge>
}
