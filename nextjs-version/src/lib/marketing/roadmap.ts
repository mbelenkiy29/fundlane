import "server-only"
import { unstable_cache } from "next/cache"
import { getDatabase } from "@/lib/mca/db"

export type RoadmapStatus = "planned" | "in_progress" | "shipped"
export type PublicRoadmapItem = { title: string; summary: string; status: RoadmapStatus; sort_order: number }

export const getPublishedRoadmap = unstable_cache(async (): Promise<PublicRoadmapItem[]> => {
  const result = await getDatabase().query<PublicRoadmapItem>(`SELECT title, summary, status, sort_order FROM roadmap_items
    WHERE published = true ORDER BY CASE status WHEN 'planned' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, sort_order, id`)
  return result.rows
}, ["public-roadmap"], { revalidate: 60, tags: ["public-roadmap"] })

export const roadmapGroups = [
  { status: "planned", title: "Planned" },
  { status: "in_progress", title: "In progress" },
  { status: "shipped", title: "Shipped" },
] as const
