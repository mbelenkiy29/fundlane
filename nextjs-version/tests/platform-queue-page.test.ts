import test,{mock} from "node:test"
import assert from "node:assert/strict"
import { isValidElement, type ReactNode } from "react"
import { AppError } from "../src/lib/mca/errors"
let denied=false
mock.module(new URL("../src/lib/mca/platform-page-access.ts",import.meta.url).href,{namedExports:{requirePlatformPage:async()=>{if(denied)throw new AppError(403,"super_admin_required","Denied");return {userId:"owner"}}}})
mock.module(new URL("../src/components/mca/platform/sms-review.tsx",import.meta.url).href,{defaultExport:()=>null})
mock.module(new URL("../src/components/mca/platform/operations-queues.tsx",import.meta.url).href,{namedExports:{OperationsQueues:()=>null}})
mock.module("next/link",{defaultExport:()=>null})
// Client components are not run on the server; examine the actual page's element selection.
function nodes(node:ReactNode):Array<{type:unknown;props:Record<string,unknown>}> {
 if(Array.isArray(node))return node.flatMap(nodes)
 if(!isValidElement<Record<string,unknown>>(node))return []
 return [{type:node.type,props:node.props},...nodes(node.props.children as ReactNode)]
}
test("SMS page defaults to safe inventory and only selects business review after explicit navigation",async()=>{
 const {default:Page}=await import("../src/app/platform/sms/page")
 const {default:Review}=await import("../src/components/mca/platform/sms-review")
 const {OperationsQueues}=await import("../src/components/mca/platform/operations-queues")
 const basic=nodes(await Page())
 assert.equal(basic.some(n=>n.type===Review),false)
 assert.equal(basic.some(n=>n.type===OperationsQueues&&n.props.kind==="sms"),true)
 assert.ok(basic.some(n=>n.props.href==="/platform/sms?view=review"))
 const reviewed=nodes(await Page({searchParams:Promise.resolve({view:"review"})}))
 assert.equal(reviewed.some(n=>n.type===Review),true)
 denied=true
 await assert.rejects(Page(),{status:403})
 await assert.rejects(Page({searchParams:Promise.resolve({view:"review"})}),{status:403})
})
