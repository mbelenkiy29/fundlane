import test,{before,after} from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { User } from "@supabase/supabase-js"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { getDatabase,nowIso,closeDatabaseForTests } from "../src/lib/mca/db"
import { linkSupabaseUser,liveSupabaseSession,resolveSupabaseMembership,verifiedSupabaseUser,type SupabaseIdentity } from "../src/lib/mca/supabase-auth"
import { acceptSupabaseInvitation,inspectSupabaseInvitation } from "../src/lib/mca/supabase-team"
import { createOpaqueToken,hashOpaqueToken } from "../src/lib/mca/crypto"
import { hashSupabaseInvitationToken } from "../src/lib/mca/invitation-token"
import { safeAuthReturnTo } from "../src/lib/mca/auth-navigation"
let database:Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async()=>{
  database=await createPostgresTestDatabase("supabase_auth");process.env.DATABASE_URL=database.databaseUrl
  await getDatabase().prepare("CREATE SCHEMA auth").run()
  await getDatabase().prepare("CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)").run()
  await getDatabase().prepare("CREATE SCHEMA IF NOT EXISTS mca_private").run()
  await getDatabase().prepare("CREATE VIEW mca_private.auth_sessions AS SELECT id,user_id,not_after FROM auth.sessions").run()
})
after(async()=>{await closeDatabaseForTests();await database?.close()})
async function fixture(){
  const email=`${randomUUID()}@example.test`
  const local=await createWorkspaceWithAdmin({workspaceName:"Supabase isolation",adminName:"Owner",adminEmail:email,password:"Unused fixture password 99!",role:"admin"})
  const id=randomUUID(),sessionId=randomUUID()
  const user={id,email,email_confirmed_at:nowIso(),app_metadata:{mca_user_id:local.userId},user_metadata:{},aud:"authenticated",created_at:nowIso()} as User
  const identity:SupabaseIdentity={user,email,sessionId}
  return {local,identity}
}
test("explicit migration mapping preserves immutable users, companies and all local roles",async()=>{
  for(const role of ["rep","manager","admin","super_admin"]){
    const f=await fixture();assert.equal(await linkSupabaseUser(f.identity),f.local.userId)
    await getDatabase().prepare("UPDATE memberships SET role=? WHERE id=?").run(role,f.local.membershipId)
    const context=await resolveSupabaseMembership(f.identity,f.local.workspaceId)
    assert.equal(context?.role,role);assert.equal(context?.userId,f.local.userId);assert.equal(context?.membershipId,f.local.membershipId)
    assert.equal(await resolveSupabaseMembership(f.identity,randomUUID()),null)
    await getDatabase().prepare("UPDATE memberships SET status='deactivated' WHERE id=?").run(f.local.membershipId)
    assert.equal(await resolveSupabaseMembership(f.identity,f.local.workspaceId),null)
  }
})
test("matching email and editable metadata cannot merge an existing account",async()=>{
  const f=await fixture()
  const forged={...f.identity,user:{...f.identity.user,app_metadata:{},user_metadata:{mca_user_id:f.local.userId}}}
  await assert.rejects(linkSupabaseUser(forged),{code:"account_migration_required"})
  assert.equal((await getDatabase().prepare<{supabase_user_id:string|null}>("SELECT supabase_user_id FROM users WHERE id=?").get(f.local.userId))?.supabase_user_id,null)
  await linkSupabaseUser(f.identity)
  await assert.rejects(linkSupabaseUser({...f.identity,user:{...f.identity.user,id:randomUUID()}}),{code:"identity_conflict"})
})
test("an invitation cannot claim an unmapped historical account or its other memberships",async()=>{
  const f=await fixture(),token=createOpaqueToken(),invitationId=randomUUID(),invitedMembership=randomUUID()
  const inviting=await fixture(),now=nowIso(),db=getDatabase()
  await db.prepare("UPDATE users SET clerk_user_id=? WHERE id=?").run(`historical-${randomUUID()}`,f.local.userId)
  await db.prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'rep','pending',?,?)").run(invitedMembership,inviting.local.workspaceId,f.local.userId,now,now)
  await db.prepare(`INSERT INTO invitations(id,workspace_id,membership_id,email,token_hash,expires_at,status,delivery_status,delivery_correlation_id,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending','sent',?,?,?,?)`).run(invitationId,inviting.local.workspaceId,invitedMembership,f.identity.email,hashSupabaseInvitationToken(token),new Date(Date.now()+60000).toISOString(),randomUUID(),inviting.local.userId,now,now)
  const freshIdentity={...f.identity,user:{...f.identity.user,app_metadata:{},user_metadata:{mca_user_id:f.local.userId}}}
  await assert.rejects(acceptSupabaseInvitation(freshIdentity,token),{code:"identity_conflict"})
  assert.equal((await db.prepare<{supabase_user_id:string|null}>("SELECT supabase_user_id FROM users WHERE id=?").get(f.local.userId))?.supabase_user_id,null)
  assert.equal((await db.prepare<{status:string}>("SELECT status FROM invitations WHERE id=?").get(invitationId))?.status,"pending")
  assert.equal(await resolveSupabaseMembership(freshIdentity,f.local.workspaceId),null)
  // Even a legacy account without a Clerk ID cannot be claimed through another company.
  await db.prepare("UPDATE users SET clerk_user_id=NULL WHERE id=?").run(f.local.userId)
  await assert.rejects(acceptSupabaseInvitation(freshIdentity,token),{code:"identity_conflict"})
  // A trusted mapping permits the real migrated identity to accept the same reserved seat.
  assert.equal(await acceptSupabaseInvitation(f.identity,token),inviting.local.workspaceId)
})
test("new pending invitation placeholders link without assuming a historical identity",async()=>{
  const f=await fixture(),db=getDatabase()
  await db.prepare("UPDATE users SET password_hash=NULL WHERE id=?").run(f.local.userId)
  await db.prepare("UPDATE memberships SET status='pending' WHERE id=?").run(f.local.membershipId)
  const fresh={...f.identity,user:{...f.identity.user,app_metadata:{}}}
  assert.equal(await linkSupabaseUser(fresh,f.local.userId),f.local.userId)
})
test("authorization checks live sessions for ownership, expiry, local revocation and provider deletion",async()=>{
  const f=await fixture()
  await getDatabase().prepare("INSERT INTO auth.sessions(id,user_id,not_after) VALUES (?,?,now()+interval '1 hour')").run(f.identity.sessionId,f.identity.user.id)
  assert.equal(await liveSupabaseSession(f.identity.sessionId,f.identity.user.id),true)
  assert.equal(await liveSupabaseSession(f.identity.sessionId,randomUUID()),false)
  await getDatabase().prepare("INSERT INTO auth_session_revocations(id,revoked_at) VALUES (?,?)").run(f.identity.sessionId,nowIso())
  assert.equal(await liveSupabaseSession(f.identity.sessionId,f.identity.user.id),false)
  await getDatabase().prepare("DELETE FROM auth_session_revocations WHERE id=?").run(f.identity.sessionId)
  await getDatabase().prepare("UPDATE auth.sessions SET not_after=now()-interval '1 second' WHERE id=?").run(f.identity.sessionId)
  assert.equal(await liveSupabaseSession(f.identity.sessionId,f.identity.user.id),false)
  await getDatabase().prepare("DELETE FROM auth.sessions WHERE id=?").run(f.identity.sessionId)
  assert.equal(await liveSupabaseSession(f.identity.sessionId,f.identity.user.id),false)
})
test("invitations require token possession plus verified matching identity and are single-use",async()=>{
  const f=await fixture(),token=createOpaqueToken(),id=randomUUID()
  await getDatabase().prepare("UPDATE memberships SET status='pending' WHERE id=?").run(f.local.membershipId)
  await getDatabase().prepare(`INSERT INTO invitations(id,workspace_id,membership_id,email,token_hash,expires_at,status,delivery_status,delivery_correlation_id,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending','sent',?,?,?,?)`).run(id,f.local.workspaceId,f.local.membershipId,f.identity.email,hashSupabaseInvitationToken(token),new Date(Date.now()+60000).toISOString(),randomUUID(),f.local.userId,nowIso(),nowIso())
  assert.match(hashSupabaseInvitationToken(token),/^supabase:[a-f0-9]{64}$/)
  await getDatabase().prepare("UPDATE invitations SET token_hash=? WHERE id=?").run(hashOpaqueToken(token),id)
  await assert.rejects(inspectSupabaseInvitation(token),{code:"invitation_invalid"})
  await assert.rejects(acceptSupabaseInvitation(f.identity,token),{code:"invitation_invalid"})
  await getDatabase().prepare("UPDATE invitations SET token_hash=? WHERE id=?").run(hashSupabaseInvitationToken(token),id)
  assert.equal((await inspectSupabaseInvitation(token)).email,f.identity.email)
  await assert.rejects(acceptSupabaseInvitation({...f.identity,email:"other@example.test"},token),{code:"invitation_account_mismatch"})
  assert.equal(await acceptSupabaseInvitation(f.identity,token),f.local.workspaceId)
  await assert.rejects(acceptSupabaseInvitation(f.identity,token),{code:"invitation_invalid"})
  assert.equal((await resolveSupabaseMembership(f.identity,f.local.workspaceId))?.role,"admin")
})
test("unverified, anonymous and banned users fail provider validation; auth redirects stay in the app",async()=>{
  const f=await fixture();assert.equal(verifiedSupabaseUser(f.identity.user),true)
  assert.equal(verifiedSupabaseUser({...f.identity.user,email_confirmed_at:undefined}),false)
  assert.equal(verifiedSupabaseUser({...f.identity.user,is_anonymous:true}),false)
  assert.equal(verifiedSupabaseUser({...f.identity.user,banned_until:new Date(Date.now()+60000).toISOString()}),false)
  for(const path of ["//evil.test","https://evil.test","/dashboard\\evil","/sign-in",null])assert.equal(safeAuthReturnTo(path),"/dashboard")
})
