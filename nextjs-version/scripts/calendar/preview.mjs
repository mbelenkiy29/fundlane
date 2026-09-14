// Synthetic localhost-only fixture; this never bypasses authentication in the application.
import { build } from "esbuild"
import postcss from "postcss"
import tailwind from "@tailwindcss/postcss"
import { readFile,mkdtemp,writeFile,rm } from "node:fs/promises"
import { join,resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
const dir=await mkdtemp(join(tmpdir(),"fundlane-calendar-preview-")),port=Number(process.env.CALENDAR_PREVIEW_PORT??5876)
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {CalendarWorkspace} from '${resolve("src/components/mca/calendar/calendar-workspace.tsx")}';
const today=new Date().toISOString().slice(0,10);
let events=[['call','Discuss funding options','14:00','14:30','scheduled'],['followup','Request September statements','16:00','16:15','scheduled'],['submission','Submitted to Northstar','12:00','12:01','sent'],['google','Personal appointment','18:00','19:00','scheduled']].map(([kind,title,start,end,status])=>({id:kind,kind,title,start:today+'T'+start+':00.000Z',end:today+'T'+end+':00.000Z',status,allDay:false,timezone:'America/New_York',editable:['call','followup'].includes(kind),dealId:kind==='google'?undefined:'merchant',dealName:kind==='google'?undefined:'Harbor Coffee',assigneeId:'rep',version:1}));
window.fetch=async(path,init={})=>{const url=new URL(path,location.origin),body=init.body?JSON.parse(init.body):null;let result;
if(url.pathname.endsWith('/google'))result={configured:true,enabled:true,connected:true,email:'avery@example.test',status:'connected',lastSync:new Date().toISOString(),calendars:[{id:'primary',name:'Personal calendar',selected:true}]};
else if(init.method==='POST'||init.method==='PATCH'){result={...body,id:url.pathname.includes('/activities/')?url.pathname.split('/').at(-1):'new-'+Date.now(),editable:true,dealName:'Harbor Coffee',version:(body.version||0)+1};events=events.filter(e=>e.id!==result.id).concat(result);}
else result={events,deals:[{id:'merchant',name:'Harbor Coffee',assigneeIds:['rep']}],assignees:[{id:'rep',name:'Avery Morgan'}],membershipId:'rep',canViewTeam:true,timezone:'America/New_York'};
return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}})};
createRoot(document.getElementById('root')).render(<CalendarWorkspace/>);`
await build({stdin:{contents:entry,loader:"jsx",resolveDir:process.cwd()},outfile:join(dir,"app.js"),bundle:true,platform:"browser",format:"esm",jsx:"automatic",tsconfig:resolve("tsconfig.json"),plugins:[{name:"preview-link",setup(b){b.onResolve({filter:/^next\/link$/},()=>({path:"link",namespace:"fixture"}));b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{...props,href},children)}",loader:"js",resolveDir:process.cwd()}))}}]})
const css=await postcss([tailwind({base:process.cwd()})]).process(await readFile("src/app/globals.css","utf8"),{from:resolve("src/app/globals.css")})
await writeFile(join(dir,"app.css"),css.css)
const server=createServer(async(req,res)=>{try{if(req.url==="/app.js"||req.url==="/app.css"){res.setHeader("content-type",req.url.endsWith("css")?"text/css":"text/javascript");res.end(await readFile(join(dir,req.url.slice(1))));return}res.setHeader("content-type","text/html");res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Calendar verification</title></head><body style="font-family:Arial,sans-serif;padding-top:24px"><main id="root"></main><script type="module" src="/app.js"></script></body></html>')}catch{res.statusCode=500;res.end('Preview failed')}})
server.listen(port,"127.0.0.1",()=>console.log(`Synthetic calendar preview: http://127.0.0.1:${port}`))
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{server.close();void rm(dir,{recursive:true,force:true}).then(()=>process.exit(0))})
