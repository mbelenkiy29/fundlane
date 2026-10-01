export interface VoiceReadiness {
  ready:boolean
  numberId:string|null
  phone:string|null
  recording:"off"
  blockers:string[]
}
export interface VoiceHistoryItem {
  id:string;direction:"inbound"|"outbound";state:string;phone:string;dealId:string|null;createdAt:string
}
