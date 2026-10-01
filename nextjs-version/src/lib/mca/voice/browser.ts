/** SDK-independent lifecycle. No automatic redial or microphone access on registration. */
export type VoiceState = "disabled"|"registering"|"ready"|"dialing"|"incoming"|"connected"|"error"
export interface VoiceSnapshot {state:VoiceState;message:string;caller?:string}
export interface VoiceCall {on(event:string,listener:(...args:unknown[])=>void):unknown;removeAllListeners():unknown;parameters:Record<string,string>;accept():void;reject():void;disconnect():void}
export interface VoiceDevice {on(event:string,listener:(...args:unknown[])=>void):unknown;removeAllListeners():unknown;register():Promise<unknown>;connect(options:{params:Record<string,string>}):Promise<VoiceCall>;updateToken(token:string):unknown;destroy():unknown}
interface Dependencies {createDevice(token:string):VoiceDevice;token():Promise<{token:string}>;presence(enabled:boolean):Promise<unknown>;intent(dealId:string):Promise<{intentId:string}>;cancelIntent(id:string):Promise<unknown>;onState(snapshot:VoiceSnapshot):void}
export class BrowserVoice {
  snapshot:VoiceSnapshot={state:"disabled",message:"Calling is disabled."}
  private device?:VoiceDevice
  private call?:VoiceCall
  private generation=0
  private callGeneration=0
  private intentId?:string
  private refreshTimer?:ReturnType<typeof setInterval>
  constructor(private readonly deps:Dependencies){}
  private set(state:VoiceState,message:string,caller?:string){this.snapshot={state,message,caller};this.deps.onState(this.snapshot)}
  async enable(){
    if(this.device || this.snapshot.state==="registering")return
    const generation=++this.generation
    this.set("registering","Connecting browser calling…")
    try{
      const {token}=await this.deps.token()
      if(generation!==this.generation)return
      const device=this.deps.createDevice(token);this.device=device
      device.on("incoming",((call:VoiceCall)=>{
        if(generation!==this.generation || this.call || this.snapshot.state!=="ready"){call.reject();return}
        this.attach(call);this.set("incoming","Incoming call",call.parameters.From)
      }) as (...args:unknown[])=>void)
      device.on("error",()=>{void this.fail()})
      device.on("unregistered",()=>{if(generation===this.generation)void this.fail()})
      device.on("tokenWillExpire",()=>{void this.refresh(generation)})
      await device.register()
      if(generation!==this.generation)return
      await this.deps.presence(true)
      if(generation!==this.generation){await this.deps.presence(false);return}
      this.set("ready","Ready for calls. Recording is off.")
      this.refreshTimer=setInterval(()=>{void this.refresh(generation)},120_000)
      this.refreshTimer.unref?.()
    }catch{if(generation===this.generation)await this.fail()}
  }
  private async refresh(generation:number){
    try{const {token}=await this.deps.token();if(generation!==this.generation)return;this.device?.updateToken(token);await this.deps.presence(true)}catch{if(generation===this.generation)await this.fail()}
  }
  private attach(call:VoiceCall){
    this.call=call
    call.on("accept",()=>{if(this.call===call)this.set("connected","Call connected. Recording is off.")})
    const ended=()=>{if(this.call!==call)return;call.removeAllListeners();this.call=undefined;this.intentId=undefined;if(this.device)this.set("ready","Call ended. Ready for calls.")}
    for(const event of ["disconnect","cancel","reject"])call.on(event,ended)
    call.on("error",()=>{void this.fail()})
  }
  async dial(dealId:string){
    if(!this.device || this.snapshot.state!=="ready")return
    const device=this.device, generation=this.generation, callGeneration=++this.callGeneration
    this.set("dialing","Calling…")
    try{
      const {intentId}=await this.deps.intent(dealId)
      if(generation!==this.generation || callGeneration!==this.callGeneration){await this.deps.cancelIntent(intentId);return}
      this.intentId=intentId
      const call=await device.connect({params:{IntentId:intentId}})
      if(generation!==this.generation || callGeneration!==this.callGeneration){call.disconnect();return}
      this.attach(call)
    }catch{if(generation===this.generation && callGeneration===this.callGeneration)await this.fail()}
  }
  answer(){if(this.snapshot.state==="incoming")this.call?.accept()}
  async end(){
    ++this.callGeneration
    const call=this.call, intentId=this.intentId, incoming=this.snapshot.state==="incoming"
    this.call=undefined;this.intentId=undefined
    if(call){call.removeAllListeners();if(incoming)call.reject();else call.disconnect()}
    if(this.device)this.set("ready","Call ended. Ready for calls.")
    if(intentId)await this.deps.cancelIntent(intentId).catch(()=>{})
  }
  async disable(){
    ++this.generation
    if(this.refreshTimer)clearInterval(this.refreshTimer);this.refreshTimer=undefined
    await this.end()
    const device=this.device;this.device=undefined
    if(device){device.removeAllListeners();device.destroy()}
    await this.deps.presence(false).catch(()=>{})
    this.set("disabled","Calling is disabled.")
  }
  private async fail(){await this.disable();this.set("error","Calling disconnected. Check browser audio/network access and retry.")}
}
