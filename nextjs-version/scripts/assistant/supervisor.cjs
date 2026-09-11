/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS container entry point. */
const { spawn } = require("node:child_process")
let exiting = false
const children = [spawn(process.execPath,["server.js"],{stdio:"inherit"})]
if (process.env.MCA_ASSISTANT_ENABLED === "true") children.push(spawn(process.execPath,["--conditions=react-server","assistant-worker.cjs"],{stdio:"inherit"}))
function stop(code, signal="SIGTERM") {
  if (exiting) return
  exiting = true
  for (const child of children) if (child.exitCode === null) child.kill(signal)
  const timer = setTimeout(()=>{ for(const child of children) if(child.exitCode===null)child.kill("SIGKILL");process.exit(code) },15000)
  Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise(resolve=>child.once("exit",resolve)))).then(()=>{clearTimeout(timer);process.exit(code)})
}
process.on("SIGTERM",()=>stop(0))
process.on("SIGINT",()=>stop(0,"SIGINT"))
for (const child of children) {
  child.on("error",()=>stop(1))
  child.on("exit",code=>{if(!exiting)stop(code||1)})
}
