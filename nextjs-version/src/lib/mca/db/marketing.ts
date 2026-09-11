import { pgTable, text } from "drizzle-orm/pg-core"

// Global sales inquiries are separate from tenant merchant/deal data.
export const marketingDemoRequests = pgTable("marketing_demo_requests", {
  request_id: text().primaryKey(),
  payload_cipher: text().notNull(),
  payload_digest: text().notNull(),
  created_at: text().notNull(),
})
