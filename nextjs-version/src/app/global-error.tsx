"use client"
import "./globals.css"
import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useReportBoundaryError } from "@/components/observability/use-report-boundary-error"

// Replaces the root layout when it fails, so it renders its own <html> and <body>.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useReportBoundaryError(error)
  return <html lang="en"><body className="antialiased"><main className="flex min-h-svh flex-col items-center justify-center p-8 text-center"><AlertCircle className="size-7 text-destructive" /><h1 className="mt-3 text-lg font-semibold">Something went wrong</h1><p className="mt-1 text-sm text-muted-foreground">Fundlane could not load this page. Your saved work is safe.</p><Button variant="outline" className="mt-4" onClick={reset}>Try again</Button></main></body></html>
}
