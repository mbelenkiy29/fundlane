"use client"

import { useState } from "react"
import { ArrowUpRight } from "lucide-react"
import { StatusChip, TimelineBar } from "./status-chip"

const deals = [
  { id: "MCA-2101", name: "Harbor Coffee", status: "REVIEW", elapsed: 42, steps: [2, 6, 17, 12, 5] },
  { id: "MCA-2102", name: "Cedar Auto Repair", status: "READY", elapsed: 36, steps: [3, 5, 12, 10, 6] },
  { id: "MCA-2103", name: "Northside Kitchen", status: "CHECK FILE", elapsed: 58, steps: [4, 11, 21, 15, 7] },
  { id: "MCA-2104", name: "Bluebird Logistics", status: "READY", elapsed: 31, steps: [2, 4, 10, 9, 6] },
] as const
const names = ["Application received", "Document checks", "Statement analysis", "Team review", "Submission preparation"]

export function ActivityStream() {
  const [selected, setSelected] = useState(0)
  const [focused, setFocused] = useState(2)
  const deal = deals[selected]
  return <section className="fl-section fl-container" aria-labelledby="activity-title">
    <div className="fl-section-heading fl-heading-split"><div><p className="fl-section-label">Every handoff, in view</p><h2 id="activity-title">Follow the work.<br />Keep the context.</h2></div><p>From the first document to a prepared submission, see the steps that move a deal forward.</p></div>
    <div className="fl-stream">
      <div className="fl-stream-header"><span>Deal activity <ArrowUpRight size={14} aria-hidden="true" /></span><div aria-live="polite"><span>{deal.id}</span><StatusChip status={deal.status === "READY" ? "success" : "neutral"}>{deal.status}</StatusChip><StatusChip>{deal.elapsed} min</StatusChip></div></div>
      <div className="fl-stream-body">
        <div className="fl-stream-sidebar" role="group" aria-label="Illustrative deals">{deals.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === index} onClick={() => { setSelected(index); setFocused(2) }}><span className={`fl-event-dot ${item.status === "READY" ? "is-success" : ""}`} /><span><strong>{item.id}</strong><small>{item.name}</small></span><ArrowUpRight size={13} aria-hidden="true" /></button>)}</div>
        <div className="fl-stream-table-wrap" role="region" aria-label="Deal activity timeline" tabIndex={0}>
          <table className="fl-stream-table"><caption className="fl-sr-only">{deal.name}: illustrative processing steps over {deal.elapsed} minutes</caption><thead><tr><th scope="col">Step</th><th scope="col">Start</th><th scope="col">Duration</th></tr></thead><tbody>{deal.steps.map((duration, index) => {
            const start = deal.steps.slice(0, index).reduce<number>((sum, value) => sum + value, 0)
            return <tr key={names[index]} className={focused === index ? "is-active" : undefined}><th scope="row"><button type="button" aria-pressed={focused === index} onClick={() => setFocused(index)}><span className="fl-step-index">0{index + 1}</span>{names[index]}</button></th><td><span className="fl-time-label">+{start} min</span><TimelineBar start={start / deal.elapsed * 100} duration={duration / deal.elapsed * 100} active={focused === index} /></td><td>{duration} min</td></tr>
          })}</tbody></table>
          <div className="fl-stream-scale"><span>0 min</span><span>{deal.elapsed} min</span></div>
        </div>
      </div>
      <p className="fl-stream-caption">Illustrative workflow and timings. Synthetic records, not measured processing performance.</p>
    </div>
  </section>
}
