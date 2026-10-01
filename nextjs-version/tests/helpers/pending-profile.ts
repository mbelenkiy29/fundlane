import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { getDatabase } from "../../src/lib/mca/db"

// Exercise real query outputs with the same historical records before and after
// re-invitation. Restore the fixture so other tests retain their original state.
export async function assertPendingProfileHidden(membershipId: string, read: () => Promise<unknown>) {
  const db = getDatabase()
  const original = await db.prepare<{ user_id: string; status: string; name: string; email: string; supabase_user_id: string | null }>(
    "SELECT m.user_id,m.status,u.name,u.email,u.supabase_user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?",
  ).get(membershipId)
  assert.ok(original)
  const privateName = `Private profile ${randomUUID()}`
  try {
    await db.prepare("UPDATE users SET name=?,supabase_user_id=? WHERE id=?").run(privateName, randomUUID(), original.user_id)
    await db.prepare("UPDATE memberships SET status='active' WHERE id=?").run(membershipId)
    assert.ok(JSON.stringify(await read()).includes(privateName), "fixture must exercise the target profile")
    await db.prepare("UPDATE memberships SET status='pending' WHERE id=?").run(membershipId)
    const pending = JSON.stringify(await read())
    assert.ok(!pending.includes(privateName), "pending membership must not expose global name")
    assert.ok(pending.includes(original.email), "pending membership should display email")
  } finally {
    await db.prepare("UPDATE memberships SET status=? WHERE id=?").run(original.status, membershipId)
    await db.prepare("UPDATE users SET name=?,supabase_user_id=? WHERE id=?").run(original.name, original.supabase_user_id, original.user_id)
  }
}
