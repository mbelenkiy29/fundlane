import "server-only"
import { z } from "zod"
import { revalidateTag } from "next/cache"
import { getDatabase, newId, withTransaction, type DbExecutor } from "./db"
import { AppError } from "./errors"

const trimmed = (max: number) => z.string().trim().min(1).max(max)
export const roadmapItemSchema = z.object({
  title: trimmed(120), summary: trimmed(500), status: z.enum(["planned", "in_progress", "shipped"]),
  sort_order: z.number().int().nonnegative(),
}).strict()
export const roadmapEditSchema = roadmapItemSchema.extend({ updated_at: z.iso.datetime({ offset: true }) })
export const roadmapChangeSchema = z.object({ updated_at: z.iso.datetime({ offset: true }) })
export type RoadmapItem = z.infer<typeof roadmapItemSchema> & { id: string; published: boolean; updated_at: string }

const columns = "id, title, summary, status, sort_order, published, updated_at"
async function audit(db: DbExecutor, id: string, actor: string, action: string, before: RoadmapItem | null, after: RoadmapItem | null) {
  await db.query(`INSERT INTO roadmap_item_audit (id, item_id, actor_user_id, action, before_value, after_value)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`, [newId(), id, actor, action, JSON.stringify(before), JSON.stringify(after)])
}
function publishedChange() { revalidateTag("public-roadmap", "max") }
function missingOrStale(): never { throw new AppError(409, "roadmap_stale", "This item changed. Reload and try again.") }

export async function listRoadmapItems(): Promise<RoadmapItem[]> {
  return (await getDatabase().query<RoadmapItem>(`SELECT ${columns} FROM roadmap_items ORDER BY CASE status WHEN 'planned' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, sort_order, id`)).rows
}

export async function createRoadmapItem(actor: string, input: z.infer<typeof roadmapItemSchema>): Promise<RoadmapItem> {
  const item = await withTransaction(async db => {
    const row = (await db.query<RoadmapItem>(`INSERT INTO roadmap_items (id,title,summary,status,sort_order,updated_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${columns}`, [newId(), input.title, input.summary, input.status, input.sort_order, actor])).rows[0]
    await audit(db, row.id, actor, "created", null, row)
    return row
  })
  publishedChange()
  return item
}

export async function changeRoadmapItem(id: string, actor: string, input: z.infer<typeof roadmapChangeSchema>, action: "update" | "publish" | "unpublish" | "delete"): Promise<RoadmapItem | null> {
  const result = await withTransaction(async db => {
    const before = (await db.query<RoadmapItem>(`SELECT ${columns} FROM roadmap_items WHERE id=$1 AND updated_at=$2::timestamptz FOR UPDATE`, [id, input.updated_at])).rows[0]
    if (!before) missingOrStale()
    let after: RoadmapItem | null = null
    if (action === "update") {
      const edit = roadmapEditSchema.parse(input)
      after = (await db.query<RoadmapItem>(`UPDATE roadmap_items SET title=$2, summary=$3, status=$4, sort_order=$5,
        updated_at=GREATEST(clock_timestamp()::timestamptz(3), updated_at + interval '1 millisecond'), updated_by_user_id=$6 WHERE id=$1 RETURNING ${columns}`,
        [id, edit.title, edit.summary, edit.status, edit.sort_order, actor])).rows[0]
    } else if (action === "delete") {
      await db.query("DELETE FROM roadmap_items WHERE id=$1", [id])
    } else {
      after = (await db.query<RoadmapItem>(`UPDATE roadmap_items SET published=$2,
        updated_at=GREATEST(clock_timestamp()::timestamptz(3), updated_at + interval '1 millisecond'), updated_by_user_id=$3 WHERE id=$1 RETURNING ${columns}`,
        [id, action === "publish", actor])).rows[0]
    }
    await audit(db, id, actor, action === "update" ? "updated" : action === "publish" ? "published" : action === "unpublish" ? "unpublished" : "deleted", before, after)
    return { before, after }
  })
  if (result.before.published || result.after?.published) publishedChange()
  return result.after
}
