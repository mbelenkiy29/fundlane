"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion"

import { cn } from "@/lib/utils"

export type TimelineEntry = {
  title: string
  content: ReactNode
}

export function Timeline({
  data,
  title,
  description,
  className,
}: {
  data: TimelineEntry[]
  title?: string
  description?: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const prefersReducedMotion = useReducedMotion()

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const updateHeight = () => {
      setHeight(element.getBoundingClientRect().height)
    }

    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start 10%", "end 50%"],
  })

  const heightTransform = useTransform(scrollYProgress, [0, 1], [0, height])
  const opacityTransform = useTransform(scrollYProgress, [0, 0.1], [0, 1])

  return (
    <div ref={containerRef} className={cn("fl-timeline w-full", className)}>
      {(title || description) && (
        <div className="mx-auto max-w-7xl px-4 py-20 md:px-8 lg:px-10">
          {title ? <h2 className="mb-4 max-w-4xl text-lg md:text-4xl">{title}</h2> : null}
          {description ? <p className="max-w-sm text-sm md:text-base">{description}</p> : null}
        </div>
      )}
      <div ref={ref} className="relative mx-auto max-w-7xl pb-20">
        {data.map((item, index) => (
          <div key={index} className="flex justify-start pt-10 md:gap-10 md:pt-40">
            <div className="sticky top-40 z-40 flex max-w-xs flex-col items-center self-start md:w-full md:flex-row lg:max-w-sm">
              <div className="fl-timeline-dot absolute left-3 flex h-10 w-10 items-center justify-center md:left-3">
                <div />
              </div>
              <h3 className="fl-timeline-title hidden md:block md:pl-20">{item.title}</h3>
            </div>
            <div className="relative w-full pl-20 pr-4 md:pl-4">
              <h3 className="fl-timeline-title mb-4 block text-left md:hidden">{item.title}</h3>
              {item.content}
            </div>
          </div>
        ))}
        <div
          style={{ height: `${height}px` }}
          className="fl-timeline-track absolute left-8 top-0 w-[2px] overflow-hidden md:left-8"
        >
          {prefersReducedMotion ? (
            <div className="fl-timeline-progress absolute inset-x-0 top-0 w-[2px]" style={{ height, opacity: 1 }} />
          ) : (
            <motion.div
              style={{ height: heightTransform, opacity: opacityTransform }}
              className="fl-timeline-progress absolute inset-x-0 top-0 w-[2px]"
            />
          )}
        </div>
      </div>
    </div>
  )
}
