'use client'
import * as React from 'react'
import {Button} from '@/components/ui/button'
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '@/components/ui/card'
import {Label} from '@/components/ui/label'
import {requestJson} from '@/lib/mca/client'
import type {DocumentCondition} from '@/lib/mca/documents/notification-facts'
import type {DocumentNotificationResult} from '@/lib/mca/documents/notification-service'
export interface DocumentAlertSnapshot {
 dealId:string;asOf:string;requiredStatementPeriod:string;conditions:DocumentCondition[]
 links:Array<{id:string;stipulationId:string;category:string;expiresAt:string;label:string}>
 templates?:Array<{id:string;name:string;channel:'email'|'sms'}>
 senders?:Array<{id:string;label:string}>
}
const reasonLabels={missing:'Missing',requested:'Requested',stale:'Stale'}
const blockMessages:Record<string,string>={notification_policy_disabled:'Company merchant reminders are disabled.',notification_consent_required:'Current merchant consent is required.',document_request_link_invalid:'Choose a live document request link.',document_request_template_invalid:'Choose a published template with the document request URL.',notification_suppressed:'The merchant has opted out of notifications.'}
export function documentNotificationStatus(result:DocumentNotificationResult){
 if(result.resolved)return 'The document condition is resolved. No notification queued.'
 return [result.broker?`Broker: ${result.broker.state==='blocked'?(blockMessages[result.broker.errorCode??'']??'Broker alert could not be queued. Review notification settings.'):stateLabel(result.broker.state)}`:undefined,result.merchant?`Merchant: ${result.merchant.state==='blocked'?(blockMessages[result.merchant.errorCode??'']??'Reminder could not be queued. Review company settings and sender configuration.'):stateLabel(result.merchant.state)}`:undefined].filter(Boolean).join(' ')
}
function stateLabel(state:string){return({queued:'Queued for delivery.',sending:'Delivery in progress.',retry:'Waiting for a safe retry.',accepted:'Accepted by the provider.',delivered:'Delivered.',suppressed:'Suppressed because the condition or permissions changed.',failed:'Delivery failed.',uncertain:'Delivery outcome unknown. Reconcile before any resend.'} as Record<string,string>)[state]??'Review notification status.'}
export function DocumentNotificationList({snapshot,onSelect}:{snapshot:DocumentAlertSnapshot;onSelect:(condition:DocumentCondition)=>void}){
 return <div className="space-y-3"><p className="text-sm text-muted-foreground">Bank statements must cover {snapshot.requiredStatementPeriod}, the previous completed UTC month. Pending scans and unscanned uploads do not satisfy document requests.</p>{snapshot.conditions.length?snapshot.conditions.map(condition=><div key={condition.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"><p><strong>{reasonLabels[condition.reason]}</strong>: {condition.label}{condition.requiredPeriod?` · ${condition.requiredPeriod}`:''}</p><Button size="sm" variant="outline" onClick={()=>onSelect(condition)}>Review alert</Button></div>):<p className="text-sm">No unresolved document conditions.</p>}</div>
}
export function DocumentNotifications({dealId,revision}:{dealId:string;revision?:number}){
 const [snapshot,setSnapshot]=React.useState<DocumentAlertSnapshot>(),[selected,setSelected]=React.useState<DocumentCondition>(),[merchant,setMerchant]=React.useState(false),[templateId,setTemplateId]=React.useState(''),[senderId,setSenderId]=React.useState(''),[linkId,setLinkId]=React.useState(''),[busy,setBusy]=React.useState(false),[message,setMessage]=React.useState<string>(),[error,setError]=React.useState<string>()
 const retry=React.useRef<{fingerprint:string;scheduledFor:string;approvedAt:string}|undefined>(undefined)
 const load=React.useCallback(async()=>{try{setSnapshot(await requestJson<DocumentAlertSnapshot>(`/api/mca/documents/notifications?dealId=${encodeURIComponent(dealId)}`));setError(undefined)}catch(caught){setError(caught instanceof Error?caught.message:'Document alerts could not be loaded.')}},[dealId])
 React.useEffect(()=>{void load()},[load,revision])
 React.useEffect(()=>{setSelected(undefined);setMerchant(false);setTemplateId('');setSenderId('');setLinkId('');setMessage(undefined);retry.current=undefined},[dealId])
 const template=snapshot?.templates?.find(item=>item.id===templateId)
 async function queue(){
  if(!selected)return
  const fingerprint=JSON.stringify({dealId,key:selected.key,merchant,templateId,senderId,linkId})
  if(!retry.current||retry.current.fingerprint!==fingerprint){const at=new Date().toISOString();retry.current={fingerprint,scheduledFor:at,approvedAt:at}}
  setBusy(true);setError(undefined)
  try{
   const result=await requestJson<DocumentNotificationResult>('/api/mca/documents/notifications',{method:'POST',body:JSON.stringify({dealId,conditionKey:selected.key,scheduledFor:retry.current.scheduledFor,approvedAt:retry.current.approvedAt,...(merchant&&template?{merchant:{channel:template.channel,templateId,...(template.channel==='email'?{senderId}:{}),linkId}}:{})})})
   setMessage(documentNotificationStatus(result));await load()
  }catch(caught){setError(caught instanceof Error?caught.message:'The alert could not be queued.')}finally{setBusy(false)}
 }
 return <Card><CardHeader><CardTitle>Document alerts</CardTitle><CardDescription>Queue a broker alert for an unresolved document condition. Merchant reminders use company settings, current consent, and a live secure request link.</CardDescription></CardHeader><CardContent className="space-y-4">{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{message&&<p role="status" className="text-sm">{message}</p>}{snapshot&&<DocumentNotificationList snapshot={snapshot} onSelect={condition=>{setSelected(condition);setMerchant(false);setLinkId('');setTemplateId('');setMessage(undefined)}}/>}{selected&&snapshot&&<div className="space-y-3 rounded-md border p-3"><p className="font-medium">{selected.label}</p><Label className="flex items-center gap-2"><input type="checkbox" checked={merchant} onChange={event=>setMerchant(event.target.checked)}/>Also queue a merchant reminder</Label>{merchant&&<><Label className="block">Published reminder template<select className="mt-1 block w-full rounded border p-2" value={templateId} onChange={event=>setTemplateId(event.target.value)}><option value="">Choose template</option>{snapshot.templates?.map(item=><option key={item.id} value={item.id}>{item.name} ({item.channel})</option>)}</select></Label>{template?.channel==='email'&&<Label className="block">Merchant email sender<select className="mt-1 block w-full rounded border p-2" value={senderId} onChange={event=>setSenderId(event.target.value)}><option value="">Choose sender</option>{snapshot.senders?.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Label>}<Label className="block">Existing document request link<select className="mt-1 block w-full rounded border p-2" value={linkId} onChange={event=>setLinkId(event.target.value)}><option value="">Choose live request link</option>{snapshot.links.filter(link=>link.category===selected.category&&(!selected.stipulationId||link.stipulationId===selected.stipulationId)).map(item=><option key={item.id} value={item.id}>{item.label} · expires {item.expiresAt}</option>)}</select></Label>{!snapshot.links.some(link=>link.category===selected.category)&&<p className="text-sm text-muted-foreground">Create a document request in the existing closing workflow first.</p>}</>}<Button onClick={()=>void queue()} disabled={busy||(merchant&&(!template||!linkId||(template.channel==='email'&&!senderId)))}>{busy?'Queuing…':merchant?'Queue broker alert and merchant reminder':'Queue broker alert'}</Button></div>}</CardContent></Card>
}
