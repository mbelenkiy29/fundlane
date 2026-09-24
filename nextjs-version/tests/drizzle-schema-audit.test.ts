import test from "node:test"
import assert from "node:assert/strict"
import { getTableConfig } from "drizzle-orm/pg-core"
import { mca_funder_groups, mca_funders, workspaces } from "../src/lib/mca/db/schema"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

test("checked migrations match the core Drizzle table definitions", async () => {
  const database = await createPostgresTestDatabase("drizzle_audit")
  try {
    for (const table of [workspaces, mca_funders, mca_funder_groups]) {
      const schema = getTableConfig(table)
      const columns = (await database.query(`SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
        ORDER BY column_name`, [schema.name])).rows
      assert.deepEqual(columns.map(row => [row.column_name, row.data_type, row.is_nullable, row.column_default]),
        schema.columns.map(column => [
          column.name, column.getSQLType(), column.notNull ? "NO" : "YES",
          column.hasDefault ? typeof column.default === "number"
            ? String(column.default) : `'${String(column.default).replaceAll("'", "''")}'::text` : null,
        ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))), schema.name)

      const constraints = (await database.query(`SELECT conname, pg_get_constraintdef(oid) definition
        FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`, [`public.${schema.name}`])).rows
      const expected = [
        `${schema.name}_pkey`,
        ...schema.columns.filter(column => column.isUnique).map(column => column.uniqueName),
        ...schema.uniqueConstraints.map(constraint => constraint.name),
        ...schema.checks.map(check => check.name),
      ].sort()
      assert.deepEqual(constraints.map(row => row.conname), expected, schema.name)
      assert.equal(constraints.find(row => row.conname === `${schema.name}_pkey`)?.definition,
        `PRIMARY KEY (${schema.columns.filter(column => column.primary).map(column => column.name).join(", ")})`)
      for (const [name, columns] of [
        ...schema.columns.filter(column => column.isUnique).map(column => [column.uniqueName, [column.name]] as const),
        ...schema.uniqueConstraints.map(constraint => [constraint.name, constraint.columns.map(column => column.name)] as const),
      ]) {
        assert.equal(constraints.find(row => row.conname === name)?.definition, `UNIQUE (${columns.join(", ")})`)
      }
      if (schema.name === "workspaces") {
        assert.equal(constraints.find(row => row.conname === "workspaces_seat_limit_check")?.definition,
          "CHECK ((seat_limit > 0))")
      }

      const indexes = (await database.query(`SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`, [schema.name])).rows
      assert.deepEqual(indexes.filter(row => !constraints.some(constraint => constraint.conname === row.indexname))
        .map(row => row.indexname), schema.indexes.map(index => index.config.name).sort(), schema.name)
      for (const index of indexes.filter(row => schema.indexes.some(item => item.config.name === row.indexname))) {
        assert.match(index.indexdef, /USING btree/)
        if (index.indexname.endsWith("_name_lower_idx")) {
          assert.match(index.indexdef, /\(workspace_id, lower\((name|legal_name)\)\)/)
        }
        if (index.indexname.endsWith("_workspace_idx")) {
          assert.match(index.indexdef, /\(workspace_id, (name|legal_name)\)/)
        }
      }
    }
  } finally {
    await database.close()
  }
})
