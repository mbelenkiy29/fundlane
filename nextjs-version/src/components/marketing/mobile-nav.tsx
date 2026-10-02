"use client"

import { useEffect, useRef } from "react"
import { Menu, X } from "lucide-react"

/** Native details keeps navigation available before hydration and without JavaScript. */
export function MobileNav({ polished = false, showPricing = false, showRoadmap = false, showTrialCta = false }: { polished?: boolean; showPricing?: boolean; showRoadmap?: boolean; showTrialCta?: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const details = ref.current!
    const summary = details.querySelector("summary")!
    let previousOverflow: string | undefined
    const restore = () => {
      if (previousOverflow !== undefined) document.body.style.overflow = previousOverflow
      previousOverflow = undefined
    }
    const toggle = () => {
      if (details.open) {
        previousOverflow ??= document.body.style.overflow
        document.body.style.overflow = "hidden"
        summary.focus()
      } else restore()
    }
    const keydown = (event: KeyboardEvent) => {
      if (!details.open) return
      if (event.key === "Escape") { event.preventDefault(); details.open = false; summary.focus() }
      if (event.key === "Tab") {
        const items = [summary, ...details.querySelectorAll<HTMLAnchorElement>("a")]
        const first = items[0], last = items[items.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    const resize = () => { if (window.innerWidth > 760) { details.open = false; restore() } }
    details.addEventListener("toggle", toggle)
    document.addEventListener("keydown", keydown)
    window.addEventListener("resize", resize)
    toggle()
    return () => { restore(); details.removeEventListener("toggle", toggle); document.removeEventListener("keydown", keydown); window.removeEventListener("resize", resize) }
  }, [])
  return <details ref={ref} className="fl-mobile-nav">
    <summary><Menu className="fl-menu-open" size={22} /><X className="fl-menu-close" size={22} /><span className="fl-menu-open fl-sr-only">Open navigation</span><span className="fl-menu-close fl-sr-only">Close navigation</span></summary>
    <nav aria-label="Mobile navigation" onClick={event => { if ((event.target as HTMLElement).closest("a")) { ref.current!.open = false; ref.current!.querySelector("summary")!.focus() } }}>
      <a href="/features">Features</a>{showPricing && <a href="/pricing">Pricing</a>}<a href="/changelog">Changelog</a>{showRoadmap && <a href="/roadmap">Roadmap</a>}<a href="/help">Help</a><a href="/#workflow">How it works</a><a href="/#faq">FAQ</a><a href="/sign-in">Login</a><a href="/demo">Book a demo {!polished && <span aria-hidden="true">↗</span>}</a>{showTrialCta && <a href="/pricing">Get Started</a>}
    </nav>
  </details>
}
