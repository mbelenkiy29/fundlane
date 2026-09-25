import * as React from "react"
import { createRoot } from "react-dom/client"
import { Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { RichResponse } from "@/components/mca/assistant/rich-response"
import { ActivityStream } from "@/components/marketing/activity-stream"

function LayoutCheck() {
  const [result, setResult] = React.useState("Not run")
  const [dark, setDark] = React.useState(false)
  async function check() {
    try {
      const assert = (ok: boolean, message: string) => { if (!ok) throw new Error(message) }
      for (const section of document.querySelectorAll<HTMLElement>("[data-layout-case]")) {
        const name = section.dataset.layoutCase!
        const scroll = section.querySelector<HTMLElement>('[data-slot="table-container"]')!
        const head = section.querySelector("thead")!
        const footer = section.querySelector("tfoot")!
        const cells = section.querySelectorAll("tbody tr:first-child td")
        const headers = section.querySelectorAll("thead th")
        assert(scroll.clientHeight <= 384, `${name}: height cap`)
        assert(scroll.tabIndex === 0, `${name}: keyboard scrolling`)
        if (name === "long" || name === "wide") assert(scroll.scrollHeight > scroll.clientHeight, `${name}: body must scroll`)
        else assert(scroll.clientHeight < 384, `${name}: short tables must shrink`)
        scroll.scrollTop = 180
        scroll.scrollLeft = 180
        await new Promise(requestAnimationFrame)
        assert(Math.abs(head.getBoundingClientRect().top - scroll.getBoundingClientRect().top) < 2, `${name}: sticky header`)
        assert(footer.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom + 2, `${name}: visible footer`)
        assert(footer.getBoundingClientRect().top > head.getBoundingClientRect().bottom, `${name}: footer does not cover header`)
        if (name !== "empty") {
          cells.forEach((cell, i) => assert(Math.abs(cell.getBoundingClientRect().x - headers[i].getBoundingClientRect().x) < 2, `${name}: aligned column ${i}`))
          assert(Math.abs(cells[0].getBoundingClientRect().x - scroll.getBoundingClientRect().x) < 2, `${name}: frozen first column`)
        }
        if (name === "wide") assert(scroll.scrollLeft > 0, "wide: horizontal scrolling")
        scroll.scrollTop = 0
        scroll.scrollLeft = 0
      }
      setResult("PASS: long, short, empty, wide, sticky header/footer, frozen columns, alignment, keyboard focus")
    } catch (error) { setResult(`FAIL: ${String(error)}`) }
  }
  return <main className={dark ? "dark" : ""}>
    <div className="space-y-6 bg-background p-4 text-foreground">
      <h1>Table layout regression</h1>
      <button className="mr-4 rounded border p-3" onClick={() => void check()}>Run layout check</button>
      <button className="rounded border p-3" onClick={() => setDark(!dark)}>Toggle theme</button>
      <p role="status">{result}</p>
      {(["long", "short", "empty", "wide"] as const).map(name => <section key={name} data-layout-case={name}>
        <h2>{name}</h2>
        <Table aria-label={`${name} table`} className={name === "wide" ? "min-w-[1600px]" : undefined}>
          <TableHeader><TableRow><TableHead className="sticky left-0 z-10 bg-background">Name</TableHead><TableHead>Details</TableHead><TableHead className="text-right">Balance</TableHead></TableRow></TableHeader>
          <TableBody>{name === "empty" ? <TableRow><TableCell colSpan={3}>No results.</TableCell></TableRow> : Array.from({ length: name === "short" ? 2 : 30 }, (_, i) => <TableRow key={i}>
            <TableCell className="sticky left-0 z-10 bg-background">Merchant {i + 1}</TableCell><TableCell>Variable length content {"detail ".repeat(i % 4)}</TableCell><TableCell className="text-right">{i * 125}</TableCell>
          </TableRow>)}</TableBody>
          <TableFooter><TableRow><TableCell colSpan={2}>Total</TableCell><TableCell className="text-right">Fixture total</TableCell></TableRow></TableFooter>
        </Table>
      </section>)}
      <h2>Assistant Markdown: right-aligned numeric column</h2>
      <RichResponse copy={false} text={"| Merchant | Amount |\n| :--- | ---: |\n" + Array.from({ length: 20 }, (_, i) => `| Merchant ${i} | ${i * 125} |`).join("\n")} />
      <div className="fundlane"><ActivityStream /></div>
    </div>
  </main>
}

createRoot(document.getElementById("root")!).render(<LayoutCheck />)
