import { build } from "esbuild"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { builtinModules } from "node:module"

const root = resolve(import.meta.dirname, "../..")
const targets = ["mca-feasibility", "mca-assistant"]
for (const name of targets) {
  const output = resolve(root, "supabase/functions", name)
  await mkdir(output, { recursive: true })
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`scripts/supabase/entries/${name}.ts`],
    outfile: `${output}/runtime.js`,
    bundle: true, minify: true, platform: "node", format: "esm", target: "es2022", metafile: true,
    banner: { js: 'import { Buffer } from "node:buffer"; import process from "node:process"; import { createRequire as __edgeCreateRequire } from "node:module"; const require = __edgeCreateRequire(import.meta.url); const global = globalThis;' },
    alias: { "server-only": "./scripts/assistant/server-only.cjs", "next/headers": "./scripts/supabase/edge-cookies.ts", "next/server": "./scripts/supabase/edge-next-server.ts" },
    external: ["pg-native"],
    plugins: [{ name: "edge-node-builtins", setup(builder) {
      builder.onResolve({ filter: /\/gcm-runtime$/ }, () => ({ path: resolve(root, "src/lib/mca/gcm-portable.ts") }))
      builder.onResolve({ filter: /^[a-z][a-z0-9_/]*$/ }, args =>
        builtinModules.includes(args.path) ? { path: `node:${args.path}`, external: true } : undefined)
    } }],
    logLevel: "warning",
  })
  if (name !== "mca-feasibility") {
    await writeFile(`${output}/index.js`, `import handler from "./runtime.js"; Deno.serve(handler);\n`)
  } else await writeFile(`${output}/index.js`, `Deno.serve(async (request) => {
    const token = Deno.env.get("MCA_EDGE_FEASIBILITY_TOKEN");
    const supplied = request.headers.get("authorization") ?? "";
    if (request.method !== "POST" || !token || token.length < 32) return new Response(null, {status: 401});
    const digest = async value => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    const a = await digest(supplied), b = await digest("Bearer " + token);
    let mismatch = 0; for (let i=0;i<a.length;i++) mismatch |= a[i]^b[i];
    if (mismatch) return new Response(null, {status: 401});
    let runtime;
    try { runtime = await import("./runtime.js"); }
    catch (error) { return Response.json({code:"module_import_failed",message:String(error.message).slice(0,300)}, {status:503}); }
    return runtime.default(request);
  });\n`)
  const source = await readFile(`${output}/runtime.js`, "utf8")
  if (/from ["']next\//.test(source)) throw new Error(`${name} includes a Next.js runtime dependency`)
  await writeFile(`${output}/deno.json`, JSON.stringify({ compilerOptions: { lib: ["deno.ns", "dom", "esnext"] } }, null, 2) + "\n")
  await mkdir(resolve(root, ".next/supabase"), { recursive: true })
  await writeFile(resolve(root, `.next/supabase/${name}.meta.json`), JSON.stringify(result.metafile))
  console.log(`${name}: ${Buffer.byteLength(source)} bytes`)
}
