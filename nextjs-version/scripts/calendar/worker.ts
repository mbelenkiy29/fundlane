import { runCalendarWorkerOnce } from "../../src/lib/mca/calendar/sync"
import { closeDatabaseForTests } from "../../src/lib/mca/db"
let stopping=false
process.on("SIGTERM",()=>{stopping=true})
process.on("SIGINT",()=>{stopping=true})
async function main() {
  do {
    try { await runCalendarWorkerOnce() } catch { console.error(JSON.stringify({event:"calendar_worker_failed"})) }
    if(process.argv.includes("--once")) break
    if(!stopping) await new Promise(resolve=>setTimeout(resolve,5000))
  } while(!stopping)
  await closeDatabaseForTests()
}
void main().catch(()=>{process.exitCode=1})
