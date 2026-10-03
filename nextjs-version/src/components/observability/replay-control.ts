import * as Sentry from "@sentry/nextjs"

// Looked up by name so this module (imported by instrumentation-client) never pulls
// the replay recorder into the bundle for public pages.
interface ReplayControls {
  startBuffering(): void
  stop(): Promise<void>
  getReplayId(): string | undefined
}

let stoppedByNavigation = false

function replay() {
  return Sentry.getClient()?.getIntegrationByName("Replay") as unknown as ReplayControls | undefined
}

/** Stops recording when the user navigates outside the signed-in workspace. */
export async function stopSessionReplay() {
  const controls = replay()
  if (!controls?.getReplayId()) return
  stoppedByNavigation = true
  try {
    await controls.stop()
  } catch {
    /* Recording is best-effort. */
  }
}

/** Resumes error/feedback buffering after returning to the workspace. */
export function resumeReplayBuffering() {
  const controls = replay()
  if (!stoppedByNavigation || !controls || controls.getReplayId()) return
  stoppedByNavigation = false
  controls.startBuffering()
}
