import { sql } from "drizzle-orm"
import { pgTable, text, integer, uniqueIndex, index } from "drizzle-orm/pg-core"
import {
  mcaAssistantConversations,
  mcaAssistantMessages,
  mcaAssistantRuns
} from "./schema"
export const assistantConversationMeta = pgTable(
  "mca_assistant_conversation_meta",
  {
    conversation_id: text()
      .primaryKey()
      .references(() => mcaAssistantConversations.id),
    title_cipher: text(),
    summary_cipher: text(),
    summary_sequence: integer().notNull().default(0),
    deleted_at: text()
  }
)
export const assistantRunMeta = pgTable("mca_assistant_run_meta", {
  run_id: text()
    .primaryKey()
    .references(() => mcaAssistantRuns.id),
  version: integer().notNull().default(2),
  elapsed_ms: integer().notNull().default(0),
  active_since: text(),
  search_calls: integer().notNull().default(0),
  code_calls: integer().notNull().default(0),
  event_sequence: integer().notNull().default(0),
  attachments_cipher: text(),
  memory_version: integer().notNull().default(0)
})
export const assistantEvents = pgTable(
  "mca_assistant_events",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => mcaAssistantRuns.id),
    sequence: integer().notNull(),
    payload_cipher: text().notNull(),
    created_at: text().notNull()
  },
  (t) => [uniqueIndex("assistant_event_sequence").on(t.run_id, t.sequence)]
)
export const assistantMessageParts = pgTable("mca_assistant_message_parts", {
  message_id: text()
    .primaryKey()
    .references(() => mcaAssistantMessages.id, { onDelete: "cascade" }),
  run_id: text().references(() => mcaAssistantRuns.id),
  payload_cipher: text().notNull()
})
export const assistantQuestions = pgTable(
  "mca_assistant_questions",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => mcaAssistantRuns.id),
    call_id: text().notNull(),
    questions_cipher: text().notNull(),
    answer_cipher: text(),
    answer_request_id: text(),
    status: text().notNull().default("pending"),
    created_at: text().notNull()
  },
  (t) => [
    uniqueIndex("assistant_question_call").on(t.run_id, t.call_id),
    uniqueIndex("assistant_answer_request").on(t.run_id, t.answer_request_id)
  ]
)
export const assistantMemorySettings = pgTable(
  "mca_assistant_memory_settings",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    user_id: text().notNull(),
    enabled: integer().notNull().default(1),
    version: integer().notNull().default(0)
  },
  (t) => [uniqueIndex("assistant_memory_owner").on(t.workspace_id, t.user_id)]
)
export const assistantMemories = pgTable(
  "mca_assistant_memories",
  {
    id: text().primaryKey(),
    settings_id: text()
      .notNull()
      .references(() => assistantMemorySettings.id),
    category: text().notNull(),
    content_cipher: text(),
    source_conversation_id: text().references(
      () => mcaAssistantConversations.id
    ),
    fingerprint: text().notNull(),
    deleted_at: text(),
    updated_at: text().notNull()
  },
  (t) => [
    uniqueIndex("assistant_memory_fingerprint").on(t.settings_id, t.fingerprint)
  ]
)
export const assistantFiles = pgTable(
  "mca_assistant_files",
  {
    id: text().primaryKey(),
    conversation_id: text()
      .notNull()
      .references(() => mcaAssistantConversations.id),
    run_id: text().references(() => mcaAssistantRuns.id),
    workspace_id: text().notNull(),
    user_id: text().notNull(),
    name_cipher: text().notNull(),
    mime: text().notNull(),
    byte_length: integer().notNull(),
    checksum: text().notNull(),
    storage_key: text().notNull(),
    state: text().notNull(),
    parent_id: text(),
    provenance_cipher: text().notNull(),
    created_at: text().notNull(),
    expires_at: text().notNull()
  },
  (t) => [
    index("assistant_files_expiry")
      .on(t.expires_at)
      .where(sql`${t.state} = 'ready'`),
    index("assistant_files_owner").on(t.workspace_id, t.user_id)
  ]
)
export const assistantCleanup = pgTable(
  "mca_assistant_cleanup",
  {
    id: text().primaryKey(),
    resource_type: text().notNull(),
    resource_id: text().notNull(),
    workspace_id: text().notNull(),
    run_id: text(),
    state: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    next_attempt_at: text().notNull()
  },
  (t) => [
    uniqueIndex("assistant_cleanup_resource").on(t.resource_type, t.resource_id)
  ]
)
