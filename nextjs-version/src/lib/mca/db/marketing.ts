import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core"

// Global sales inquiries are separate from tenant merchant/deal data.
export const marketingDemoRequests = pgTable("marketing_demo_requests", {
  request_id: text().primaryKey(),
  payload_cipher: text().notNull(),
  payload_digest: text().notNull(),
  created_at: text().notNull(),
})

export const marketingDemoSubmissions = pgTable("marketing_demo_submissions", {
  request_id: text().primaryKey(),
  payload_digest: text().notNull(),
  name: text().notNull(),
  email: text().notNull(),
  brokerage: text().notNull(),
  team_size: text().notNull(),
  message: text().notNull().default(""),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("marketing_demo_submissions_created_idx").on(table.created_at.desc())])
