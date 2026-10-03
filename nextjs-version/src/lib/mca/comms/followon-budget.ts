type FollowonRunner<T> = (clock: string, deadlineMs: number) => Promise<T>

/** Follow-on discovery runs after dispatch and shares only the tick's remaining time.
 * Producers must stop their I/O at the supplied deadline; a promise race cannot
 * safely cancel their database writes or provider requests.
 */
export async function runCommsFollowons<Replies, Renewals>(input: {
  clock: string
  deadlineMs: number
  replies?: FollowonRunner<Replies>
  renewals?: FollowonRunner<Renewals>
  now?: () => number
}): Promise<{ funderReplies?: Replies; renewalAlerts?: Renewals }> {
  const now = input.now ?? Date.now
  const result: { funderReplies?: Replies; renewalAlerts?: Renewals } = {}
  const started = now()
  if (started >= input.deadlineMs) return result
  if (input.replies) {
    const replyDeadline = input.renewals
      ? started + Math.floor((input.deadlineMs - started) / 2)
      : input.deadlineMs
    result.funderReplies = await input.replies(input.clock, replyDeadline)
  }
  if (input.renewals && now() < input.deadlineMs) {
    result.renewalAlerts = await input.renewals(input.clock, input.deadlineMs)
  }
  return result
}
