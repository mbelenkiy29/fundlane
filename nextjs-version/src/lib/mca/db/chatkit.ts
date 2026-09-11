import { bigint, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core"
import { users, workspaces } from "./schema"

export const chatkitThreads = pgTable("mca_chatkit_threads", {
  id: text().primaryKey(),
  workspace_id: text().notNull().references(() => workspaces.id),
  user_id: text().notNull().references(() => users.id),
  payload_cipher: text().notNull(),
  access_stamp: text().notNull(),
  created_at: text().notNull(),
}, table => [index("mca_chatkit_threads_owner_idx").on(table.workspace_id, table.user_id, table.created_at, table.id)])
export const chatkitItems = pgTable("mca_chatkit_items", {
  thread_id: text().notNull().references(() => chatkitThreads.id, { onDelete: "cascade" }),
  id: text().notNull(), payload_cipher: text().notNull(), sequence: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
}, table => [primaryKey({ columns: [table.thread_id, table.id] }), index("mca_chatkit_items_page_idx").on(table.thread_id, table.sequence)])
export const chatkitReferences = pgTable("mca_chatkit_references", {
  thread_id: text().notNull().references(() => chatkitThreads.id, { onDelete: "cascade" }), deal_id: text().notNull(),
}, table => [primaryKey({ columns: [table.thread_id, table.deal_id] })])
export const chatkitRequests = pgTable("mca_chatkit_requests", {
  id: text().primaryKey(), workspace_id: text().notNull().references(() => workspaces.id),
  user_id: text().notNull().references(() => users.id), expires_at: text().notNull(), is_turn: integer().notNull().default(0),
}, table => [index("mca_chatkit_requests_owner_idx").on(table.workspace_id, table.user_id, table.expires_at)])
