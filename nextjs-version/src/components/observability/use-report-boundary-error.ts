"use client"

import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"

/**
 * Reports an error caught by an App Router error boundary. Errors with a digest
 * came from the server and were already reported by `onRequestError`.
 */
export function useReportBoundaryError(error: Error & { digest?: string }) {
  useEffect(() => {
    if (!error.digest) Sentry.captureException(error)
  }, [error])
}
