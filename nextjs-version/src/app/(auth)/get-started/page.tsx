import { GetStarted } from "./get-started"
export default async function GetStartedPage({searchParams}:{searchParams:Promise<{canceled?:string}>}) {
  return <GetStarted canceled={(await searchParams).canceled==="1"}/>
}
