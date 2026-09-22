"use client"
import { Suspense,useEffect,useState } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AuthShell } from "@/components/mca/auth-shell"
import TeamPanel from "@/components/mca/team-panel"
import { BillingPanel } from "@/components/mca/billing-panel"
import { SeatSelector } from "@/components/mca/seat-selector"
import { validSelectedSeats } from "@/lib/mca/billing-display"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage,safeAuthReturnTo } from "@/lib/mca/auth-navigation"
type Account={authenticated:boolean;passwordSetupRequired?:boolean;workspaces:{id:string;name:string;role:string}[];companyName?:string}
export default function OnboardingPage(){return <Suspense><Onboarding/></Suspense>}
function Onboarding(){
  const [selectedSeats,setSelectedSeats]=useState(1)
  const params=useSearchParams(),switching=params.get("switch")==="1",resumeSetup=params.get("setup")==="1",destination=safeAuthReturnTo(params.get("returnTo"))
  const [account,setAccount]=useState<Account|null>(null),[name,setName]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[setup,setSetup]=useState(false),[billing,setBilling]=useState(false)
  useEffect(()=>{let cancelled=false;requestJson<Account>("/api/onboarding").then(async value=>{if(cancelled)return;setAccount(value);setName(value.companyName??"");if(value.authenticated&&!value.passwordSetupRequired&&resumeSetup){setSetup(true);setBilling(true);return}if(value.authenticated&&!value.passwordSetupRequired&&value.workspaces.length===1&&!switching){await requestJson("/api/onboarding",{method:"POST",body:JSON.stringify({workspaceId:value.workspaces[0].id})});window.location.href=destination}}).catch(e=>{if(!cancelled)setError(authErrorMessage(e))});return()=>{cancelled=true}},[switching,destination,resumeSetup])
  async function select(input:{workspaceId:string}|{name:string}){setBusy(true);setError("");try{await requestJson("/api/onboarding",{method:"POST",body:JSON.stringify("name" in input ? {...input,selectedSeats} : input)});if("name" in input){setSetup(true);setBilling(true)}else window.location.href=destination}catch(e){setError(authErrorMessage(e))}finally{setBusy(false)}}
  if(setup&&billing)return <main className="mx-auto max-w-6xl p-6"><BillingPanel onboarding onContinue={()=>setBilling(false)}/></main>
  if(setup)return <main className="mx-auto max-w-6xl space-y-6 p-6"><header><h1 className="text-2xl font-semibold">Invite your employees</h1><p className="text-muted-foreground">Choose each employee’s role and manager. You can invite people later from Team settings.</p></header><TeamPanel/><Button onClick={()=>window.location.href="/settings/connections"}>Continue to business setup</Button><Button variant="ghost" onClick={()=>window.location.href="/dashboard"}>Finish later</Button></main>
  return <AuthShell title="Set up your company" description="Select an existing company or create a new company workspace.">
    {error&&<p role="alert" className="mb-4 text-destructive">{error}</p>}
    {!account?<p>Loading your account…</p>:!account.authenticated?<Button asChild><a href="/sign-in">Sign in to continue</a></Button>:account.passwordSetupRequired?<><p>Activate your migrated account by setting a new password.</p><Button asChild className="mt-4"><a href="/forgot-password">Recover your account</a></Button></>:<>
      <div className="space-y-2">{account.workspaces.map(workspace=><Button key={workspace.id} variant="outline" className="w-full justify-between" disabled={busy} onClick={()=>select({workspaceId:workspace.id})}>{workspace.name}<span className="text-xs text-muted-foreground">{workspace.role}</span></Button>)}</div>
      <form className="mt-6 space-y-4" onSubmit={e=>{e.preventDefault();void select({name})}}><Label className="grid gap-2">New company name<Input value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={200} required/></Label><SeatSelector value={selectedSeats} onChange={setSelectedSeats}/><p className="text-sm text-muted-foreground">Start a 14-day trial with no card. Trial access includes up to 5 users, even if you select more paid seats. No automatic charge; subscribe when ready.</p><Button className="w-full" disabled={busy||!validSelectedSeats(selectedSeats)}>Create company & start free trial</Button></form>
    </>}
    {account?.authenticated&&<Button variant="ghost" className="mt-4" onClick={async()=>{await requestJson("/api/auth/sign-out",{method:"POST"});window.location.href="/sign-in"}}>Sign out</Button>}
  </AuthShell>
}
