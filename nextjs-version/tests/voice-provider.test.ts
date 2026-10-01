import test from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { createVoiceToken, identityFor, outboundTwiml, inboundTwiml, verifyVoiceWebhook } from "../src/lib/mca/voice/provider"
const credentials = {accountSid: `AC${"1".repeat(32)}`, authToken:"synthetic-auth", apiKeySid:`SK${"2".repeat(32)}`, apiKeySecret:"synthetic-key", applicationSid:`AP${"3".repeat(32)}`,publicOrigin:"https://example.test"}
test("tokens expire in five minutes with only tenant/member Voice grants", () => {
 const identity=identityFor("tenant-a","member-a")
 assert.notEqual(identity,identityFor("tenant-b","member-a"))
 assert.match(identity,/^[A-Za-z0-9_]{1,121}$/)
 const {token,expiresAt}=createVoiceToken(credentials,identity,1_000_000)
 const [header,body,signature]=token.split(".")
 assert.equal(signature,createHmac("sha256",credentials.apiKeySecret).update(`${header}.${body}`).digest("base64url"))
 const claims=JSON.parse(Buffer.from(body,"base64url").toString())
 assert.equal(claims.exp-claims.iat,300)
 assert.equal(expiresAt,new Date(1_300_000).toISOString())
 assert.deepEqual(claims.grants,{identity,voice:{incoming:{allow:true},outgoing:{application_sid:credentials.applicationSid}}})
 assert.equal(claims.iss,credentials.apiKeySid); assert.equal(claims.sub,credentials.accountSid)
 assert.ok(!token.includes(credentials.authToken))
})
test("TwiML always disables recording and escapes callbacks",()=>{
 const xml=outboundTwiml("+15555550101","+15555550102","https://example.test/action?a=1&b=2")
 assert.match(xml,/record="do-not-record"/); assert.match(xml,/a=1&amp;b=2/)
 assert.match(inboundTwiml([identityFor("a","b")],"https://example.test/action"),/<Client>/)
 assert.match(inboundTwiml([],"https://example.test/action"),/<Reject/)
 assert.throws(()=>outboundTwiml("+15555550101","client:fake","https://example.test/action"))
})
function signed(body:string,url:string){const params=new URLSearchParams(body); let payload=url; for(const key of [...params.keys()].sort())payload+=key+params.get(key); return createHmac("sha1",credentials.authToken).update(payload).digest("base64")}
test("webhooks verify canonical URL, account, unique fields and bounded body",async()=>{
 const url="https://example.test/api/mca/voice/hook"; const body=`AccountSid=${credentials.accountSid}&CallSid=CA${"4".repeat(32)}`
 const request=(value=body,signature=signed(value,url))=>new Request(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","x-twilio-signature":signature},body:value})
 assert.equal((await verifyVoiceWebhook(request(),credentials,url)).get("AccountSid"),credentials.accountSid)
 await assert.rejects(verifyVoiceWebhook(request(body,"forged"),credentials,url))
 await assert.rejects(verifyVoiceWebhook(request(),credentials,url+"?wrong=1"))
 await assert.rejects(verifyVoiceWebhook(request(body+"&AccountSid=foreign"),credentials,url))
 await assert.rejects(verifyVoiceWebhook(request(body.replace(credentials.accountSid,`AC${"9".repeat(32)}`)),credentials,url))
 await assert.rejects(verifyVoiceWebhook(request(body+"&Padding="+"x".repeat(17000)),credentials,url))
})
