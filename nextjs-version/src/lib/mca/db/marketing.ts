import { pgTable, text, timestamp, index, integer } from "drizzle-orm/pg-core"

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
  payload_cipher: text().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  notified_at: timestamp({ withTimezone: true }),
  notification_error: text(),
  notification_attempts: integer().notNull().default(0),
  notification_lease_until: timestamp({ withTimezone: true }),
}, (table) => [index("marketing_demo_submissions_created_idx").on(table.created_at.desc())])
