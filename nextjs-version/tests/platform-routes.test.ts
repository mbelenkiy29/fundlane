import test,{mock,before} from "node:test"
import assert from "node:assert/strict"
import { AppError } from "../src/lib/mca/errors"
import { z } from "zod"

let denial:AppError|null=new AppError(403,"platform_admin_required","Platform access required.")
let reads=0,mutations=0,originChecks=0
mock.module(new URL("../src/lib/mca/platform-auth.ts",import.meta.url).href,{namedExports:{requirePlatformAdmin:async()=>{if(denial)throw denial;return {userId:"operator"}}}})
mock.module(new URL("../src/lib/mca/auth.ts",import.meta.url).href,{namedExports:{assertTrustedMutation:(request:Request)=>{originChecks++;if(request.headers.get("origin")!=="https://app.example")throw new AppError(403,"untrusted_origin","Untrusted origin.")}}})
mock.module(new URL("../src/lib/mca/platform-console.ts",import.meta.url).href,{namedExports:{
  platformQuerySchema:z.object({q:z.string().default(""),status:z.string().default(""),offset:z.coerce.number().int().min(0).default(0)}),
  platformActionSchema:z.object({action:z.literal("access"),reason:z.string().min(1),manualPaused:z.boolean()}),
  platformCompanies:async()=>{reads++;return []},platformCompany:async()=>{reads++;return {}},platformPayments:async()=>{reads++;return {}},platformAudit:async()=>{reads++;return []},
  platformMutation:async(id:string,actor:string)=>{mutations++;return {id,actor}},
}})
let companies:typeof import("../src/app/api/platform/companies/route")
let company:typeof import("../src/app/api/platform/companies/[id]/route")
let payments:typeof import("../src/app/api/platform/payments/route")
let audit:typeof import("../src/app/api/platform/audit/route")
before(async()=>{[companies,company,payments,audit]=await Promise.all([import("../src/app/api/platform/companies/route"),import("../src/app/api/platform/companies/[id]/route"),import("../src/app/api/platform/payments/route"),import("../src/app/api/platform/audit/route")])})
const context={params:Promise.resolve({id:"company"})}
const request=(body?:object,origin="https://app.example")=>new Request("https://app.example/api/platform/companies/company",{method:body?"POST":"GET",headers:{origin,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})})
test("all platform routes reject absent grants and AAL1 before reading or mutating records",async()=>{
  for(const [status,code] of [[401,"authentication_required"],[403,"platform_admin_required"],[403,"mfa_required"]] as const){
    denial=new AppError(status,code,"Denied")
    for(const response of await Promise.all([companies.GET(request()),company.GET(request(),context),payments.GET(request()),audit.GET(request()),company.POST(request({action:"access",reason:"test",manualPaused:true}),context),...['notification_retry','notification_resend','assign_owner'].map(action=>company.POST(request({action,notificationId:"notice",membershipId:"member",reason:"Reviewed"}),context))])){
      assert.equal(response.status,status);assert.equal((await response.json()).error.code,code);assert.equal(response.headers.get("location"),null)
    }
  }
  assert.equal(reads,0);assert.equal(mutations,0);assert.equal(originChecks,0)
})
test("authorized routes retain origin protection, reason validation and trusted actor identity",async()=>{
  denial=null
  assert.equal((await companies.GET(request())).status,200)
  assert.equal((await company.POST(request({action:"access",reason:"Support request",manualPaused:true},"https://evil.example"),context)).status,403)
  assert.equal((await company.POST(request({action:"access",reason:"",manualPaused:true}),context)).status,400)
  assert.equal(mutations,0)
  const response=await company.POST(request({action:"access",reason:"Support request",manualPaused:true,actor:"forged"}),context)
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{id:"company",actor:"operator"});assert.equal(mutations,1)
})
