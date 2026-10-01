/** Both network boundaries must retain the current inbox selection/context. */
export async function refreshSmsConversation<T>(input: {
  read: () => Promise<T>
  isCurrent: () => boolean
  show: (detail: T) => void
  acknowledge: () => Promise<unknown>
  refreshList: () => Promise<unknown>
}): Promise<void> {
  const detail = await input.read()
  if (!input.isCurrent()) return
  input.show(detail)
  await input.acknowledge()
  if (!input.isCurrent()) return
  await input.refreshList()
}
