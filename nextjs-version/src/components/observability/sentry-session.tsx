"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"
import * as Sentry from "@sentry/nextjs"
import { replayAllowedPath } from "@/lib/observability/scrub"
import { resumeReplayBuffering } from "./replay-control"
import { ensureFeedbackIntegration, ensureReplayIntegration, sentryActive } from "./session-integrations"

const USER_KEY = "fl.sentryUser"
const REPLAY_SESSION_KEY = "sentryReplaySession"

type SessionUser = { id: string; email: string; name: string }
type SessionWorkspace = { id: string; name: string; role: string }

/**
 * Identifies the signed-in user for Sentry and starts masked Session Replay on
 * workspace and platform pages. Renders nothing; inert without a public DSN.
 */
export function SentrySession({ user, workspace, platformOperator = false }: { user: SessionUser; workspace?: SessionWorkspace; platformOperator?: boolean }) {
  const pathname = usePathname()
  const { id: userId, email, name } = user
  const { id: workspaceId, name: workspaceName, role } = workspace ?? {}

  useEffect(() => {
    if (!sentryActive()) return
    Sentry.setUser({ id: userId, email, username: name })
    Sentry.setTags({ workspace_id: workspaceId, role, platform_operator: platformOperator ? "true" : undefined })
    Sentry.setContext("workspace", workspaceId ? { id: workspaceId, name: workspaceName } : null)
    try {
      // Replay sessions are sticky per tab; a different user never continues one.
      if (sessionStorage.getItem(USER_KEY) !== userId) {
        sessionStorage.removeItem(REPLAY_SESSION_KEY)
        sessionStorage.setItem(USER_KEY, userId)
      }
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
  }, [userId, email, name, workspaceId, workspaceName, role, platformOperator])

  useEffect(() => {
    if (!sentryActive()) return
    ensureFeedbackIntegration()
    if (!replayAllowedPath(pathname)) return
    ensureReplayIntegration()
    resumeReplayBuffering()
  }, [pathname])

  return null
}
