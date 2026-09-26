import test from "node:test"
import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"

test("missing-row company keeps every existing operator control available with an audit reason",()=>{
  const result=spawnSync(process.execPath,["--import","tsx","-e",`
    const React=require('react')
    const {renderToStaticMarkup}=require('react-dom/server')
    const {AppRouterContext}=require('next/dist/shared/lib/app-router-context.shared-runtime')
    const originalUseState=React.useState
    let calls=0
    React.useState=initial=>{
      calls++
      if(calls===1)return ['Reviewed by operator',()=>{}]
      if(calls===2)return ['2099-01-01T12:00',()=>{}]
      return [initial,()=>{}]
    }
    const {CompanyControls}=require('./src/components/mca/platform/company-controls.tsx')
    const html=renderToStaticMarkup(React.createElement(AppRouterContext.Provider,{value:{refresh(){}}},React.createElement(CompanyControls,{id:'missing',paused:false,billingState:null,owner:null,ownerCandidates:[],notifications:[]})))
    React.useState=originalUseState
    const labels=['Pause company access','Reconcile with Stripe','Set access extension','Clear extension']
    console.log(JSON.stringify({controls:labels.map(label=>html.match(new RegExp('<button[^>]*>'+label+'</button>'))?.[0]??null),resolution:html.includes('Resolve missing billing state')}))
  `],{encoding:"utf8",env:{...process.env,MCA_BILLING_MISSING_STATE_FAIL_CLOSED:""}})
  assert.equal(result.status,0,result.stderr)
  const rendered=JSON.parse(result.stdout.trim()) as {controls:(string|null)[];resolution:boolean}
  assert.equal(rendered.resolution,true)
  for(const control of rendered.controls){
    assert.ok(control,"Original operator control is present")
    assert.doesNotMatch(control,/\sdisabled(?:=|\s|>)/)
  }
})
