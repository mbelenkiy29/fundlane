// Local GoTrue protocol fixture uses signed JWTs, the actual SSR cookie codec, and live auth.sessions.
// No production authentication bypass or external provider account is required.
import { createServer } from "node:http"
import { generateKeyPairSync,sign,randomUUID } from "node:crypto"
import { closeDatabaseForTests } from "../../src/lib/mca/db.ts"
import { createWorkspaceWithAdmin } from "../../src/lib/mca/workspaces.ts"
import { createSession,getSessionResponse } from "../../src/lib/mca/sessions.ts"
import { hashOpaqueToken,verifyPassword } from "../../src/lib/mca/crypto.ts"
export async function createSupabaseHttpFixture(database){
  Object.assign(process.env,database.env())
  await database.query("CREATE SCHEMA IF NOT EXISTS auth")
  await database.query("CREATE TABLE IF NOT EXISTS auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)")
  await database.query("CREATE SCHEMA IF NOT EXISTS mca_private")
  await database.query("CREATE OR REPLACE VIEW mca_private.auth_sessions AS SELECT id,user_id,not_after FROM auth.sessions")
  const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048})
  const jwk={...publicKey.export({format:"jwk"}),kid:"supabase-fixture",alg:"RS256",use:"sig"}
  const identityState={passwordEnabled:true,verified:true,banned:false,sessionStatus:null}
  const invitations=[],provisioned=new Set()
  let origin
  function userFor(row){return {id:row.id,email:row.email,aud:"authenticated",role:"authenticated",created_at:row.created_at,email_confirmed_at:identityState.verified?row.created_at:null,is_anonymous:false,banned_until:identityState.banned?"2099-01-01T00:00:00Z":null,app_metadata:{mca_user_id:row.id,mca_migration_pending:!identityState.passwordEnabled},user_metadata:{name:row.name},identities:[]}}
  function accessToken(userId,sessionId){const now=Math.floor(Date.now()/1000),part=x=>Buffer.from(JSON.stringify(x)).toString("base64url");const unsigned=`${part({alg:"RS256",typ:"JWT",kid:jwk.kid})}.${part({iss:`${origin}/auth/v1`,sub:userId,session_id:sessionId,aud:"authenticated",role:"authenticated",aal:"aal1",amr:[{method:"password",timestamp:now}],iat:now,exp:now+3600})}`;return `${unsigned}.${sign("RSA-SHA256",Buffer.from(unsigned),privateKey).toString("base64url")}`}
  async function sessionFor(row){
    await database.query("UPDATE users SET supabase_user_id=id::uuid WHERE id=$1",[row.user_id])
    if(!provisioned.has(row.id)){await database.query("INSERT INTO auth.sessions(id,user_id,not_after) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[row.id,row.user_id,row.expires_at]);provisioned.add(row.id)}
    const user=(await database.query("SELECT * FROM users WHERE id=$1",[row.user_id])).rows[0]
    return {access_token:accessToken(row.user_id,row.id),refresh_token:`refresh_${row.id}`,token_type:"bearer",expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:userFor(user)}
  }
  const api=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,"http://localhost"),path=url.pathname
      let body="";for await(const chunk of req)body+=chunk
      const input=body?JSON.parse(body):{},bearer=req.headers.authorization?.replace(/^Bearer /,""),claims=bearer?.split(".").length===3?JSON.parse(Buffer.from(bearer.split(".")[1],"base64url").toString()):null
      let data,status=200
      if(path==="/auth/v1/.well-known/jwks.json")data={keys:[jwk]}
      else if(path==="/auth/v1/user"||path.startsWith("/auth/v1/admin/users/")){
        const id=path.startsWith("/auth/v1/admin/users/")?path.split("/").at(-1):claims?.sub
        const row=id?(await database.query("SELECT * FROM users WHERE id=$1",[id])).rows[0]:null
        if(!row||identityState.sessionStatus){status=401;data={code:"session_not_found",message:"Session no longer exists"}}
        else data=path.startsWith("/auth/v1/admin/")?{user:userFor(row)}:userFor(row)
      }else if(path==="/auth/v1/token"){
        const row=(await database.query(`SELECT s.*,u.password_hash,m.workspace_id FROM users u JOIN memberships m ON m.user_id=u.id JOIN sessions s ON s.membership_id=m.id WHERE lower(u.email)=lower($1) ORDER BY s.created_at DESC LIMIT 1`,[input.email??""])).rows[0]
        if(!row||!verifyPassword(input.password??"",row.password_hash)){status=400;data={code:"invalid_credentials",message:"Invalid login credentials"}}
        else data=await sessionFor(row)
      }else if(path==="/auth/v1/logout"){
        if(claims?.session_id)await database.query("DELETE FROM auth.sessions WHERE id=$1",[claims.session_id]);res.writeHead(204).end();return
      }else if(path==="/auth/v1/recover"||path==="/auth/v1/resend")data={}
      else if(path==="/email"){
        const token=new URL(input.actionUrl).searchParams.get("token")
        invitations.push({...input,email_address:input.recipient,token,status:"pending"});data={success:true}
      }else{status=404;data={code:"not_found",message:"Fixture endpoint unavailable"}}
      res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(data))
    }catch(error){console.error("Supabase protocol fixture:",error.message);res.writeHead(500).end()}
  })
  await new Promise(resolve=>api.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${api.address().port}`
  const env={MCA_CLERK_BILLING_ENABLED:"false",MCA_STRIPE_BILLING_ENABLED:"false",NEXT_PUBLIC_SUPABASE_URL:origin,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:"sb_publishable_fixture",SUPABASE_SECRET_KEY:"sb_secret_fixture",MCA_EMAIL_WEBHOOK_URL:`${origin}/email`}
  async function login(email,password){
    let result=await database.query(`SELECT m.id membership_id,m.workspace_id,m.role,u.id user_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower($1) AND m.status='active' LIMIT 1`,[email])
    if(!result.rows[0]){await createWorkspaceWithAdmin({workspaceName:"HTTP fixture company",adminName:"Owner",adminEmail:email,password});result=await database.query(`SELECT m.id membership_id,m.workspace_id,m.role,u.id user_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower($1) LIMIT 1`,[email])}
    const row=result.rows[0],session=await createSession(row.user_id,row.membership_id)
    const payload=await getSessionResponse({authType:"session",userId:row.user_id,membershipId:row.membership_id,workspaceId:row.workspace_id,role:row.role,scopes:[],sessionId:"fixture"})
    return {response:new Response(null,{status:200}),payload,cookie:`mca_session=${session.token}`}
  }
  async function headers(cookie){
    if(!cookie)return {}
    if(!cookie.startsWith("mca_session="))return {cookie}
    const row=(await database.query(`SELECT s.*,m.workspace_id FROM sessions s JOIN memberships m ON m.id=s.membership_id WHERE s.token_hash=$1`,[hashOpaqueToken(cookie.slice("mca_session=".length))])).rows[0]
    if(!row)return {cookie}
    const session=await sessionFor(row),encoded=`base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`
    return {cookie:`sb-127-auth-token=${encoded}; mca_workspace=${row.workspace_id}`}
  }
  return {env,login,headers,invitations,identityState,id:randomUUID(),close:async()=>{await closeDatabaseForTests();api.closeAllConnections();await new Promise(resolve=>api.close(resolve))}}
}
