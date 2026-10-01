import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs";

mock.module("next/cache", { exports: {
  unstable_cache: fn => fn,
  revalidateTag: () => {},
} });

test("roadmap mutations keep publication and audit atomic on disposable PostgreSQL", async () => {
  const fixture = await createPostgresTestDatabase("roadmap");
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = fixture.databaseUrl;
  try {
    const { createRoadmapItem, changeRoadmapItem, listRoadmapItems, roadmapItemSchema } = await import("../src/lib/mca/roadmap-admin.ts");
    const { getPublishedRoadmap } = await import("../src/lib/marketing/roadmap.ts");
    const actor = "roadmap-test-actor";
    await fixture.query("INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)", [actor, "roadmap@example.test", "Roadmap operator", actor, new Date().toISOString()]);
    for (const invalid of [
      { title: "", summary: "Summary", status: "planned", sort_order: 0 },
      { title: "X".repeat(121), summary: "Summary", status: "planned", sort_order: 0 },
      { title: "Title", summary: "X".repeat(501), status: "planned", sort_order: 0 },
      { title: "Title", summary: "Summary", status: "unknown", sort_order: 0 },
      { title: "Title", summary: "Summary", status: "planned", sort_order: -1 },
    ]) assert.equal(roadmapItemSchema.safeParse(invalid).success, false);
    const created = await createRoadmapItem(actor, { title: "<Safe>", summary: "Visible & escaped", status: "planned", sort_order: 0 });
    assert.equal((await getPublishedRoadmap()).length, 0);
    assert.equal((await listRoadmapItems()).length, 1);
    const published = await changeRoadmapItem(created.id, actor, { updated_at: new Date(created.updated_at).toISOString() }, "publish");
    assert.equal((await getPublishedRoadmap())[0].title, "<Safe>");
    await assert.rejects(() => changeRoadmapItem(created.id, actor, { updated_at: new Date(created.updated_at).toISOString() }, "delete"), error => error.status === 409);
    assert.equal((await fixture.query("SELECT count(*)::int n FROM roadmap_items")).rows[0].n, 1);
    await fixture.query(`CREATE FUNCTION reject_roadmap_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit rejected'; END $$`);
    await fixture.query("CREATE TRIGGER reject_roadmap_audit BEFORE INSERT ON roadmap_item_audit FOR EACH ROW EXECUTE FUNCTION reject_roadmap_audit()");
    await assert.rejects(() => changeRoadmapItem(created.id, actor, { updated_at: new Date(published.updated_at).toISOString() }, "unpublish"), /audit rejected/);
    assert.equal((await fixture.query("SELECT published FROM roadmap_items WHERE id=$1", [created.id])).rows[0].published, true);
    await fixture.query("DROP TRIGGER reject_roadmap_audit ON roadmap_item_audit");
    const unpublished = await changeRoadmapItem(created.id, actor, { updated_at: new Date(published.updated_at).toISOString() }, "unpublish");
    assert.equal((await getPublishedRoadmap()).length, 0);
    await changeRoadmapItem(created.id, actor, { updated_at: new Date(unpublished.updated_at).toISOString() }, "delete");
    assert.equal((await fixture.query("SELECT count(*)::int n FROM roadmap_items")).rows[0].n, 0);
    assert.deepEqual((await fixture.query("SELECT action FROM roadmap_item_audit ORDER BY created_at, action")).rows.map(row => row.action).sort(), ["created", "deleted", "published", "unpublished"]);
    assert.equal((await fixture.query("SELECT bool_and(relrowsecurity) secured FROM pg_class WHERE oid IN ('roadmap_items'::regclass,'roadmap_item_audit'::regclass)")).rows[0].secured, true);
  } finally {
    const { closeDatabaseForTests } = await import("../src/lib/mca/db.ts");
    try { await closeDatabaseForTests(); }
    finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await fixture.close();
    }
  }
});
