export function StatusChip({ children, status = "neutral" }: { children: React.ReactNode; status?: "success" | "active" | "neutral" | "error" }) {
  return <span className={`fl-chip fl-chip-${status}`}><span aria-hidden="true" />{children}</span>
}

export function TimelineBar({ start, duration, active = false }: { start: number; duration: number; active?: boolean }) {
  return <span className="fl-timeline" aria-hidden="true"><span style={{ left: `${start}%`, width: `${duration}%` }} className={active ? "is-active" : undefined} /></span>
}
