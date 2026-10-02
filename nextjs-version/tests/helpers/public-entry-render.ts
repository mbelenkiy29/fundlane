import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

export function runClient(script: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], {
    cwd: resolve(import.meta.dirname, "..", ".."),
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

export const renderSetup = `
  const React = require("react");
  const { mock } = require("node:test");
  const { renderToStaticMarkup } = require("react-dom/server");
  require.extensions[".css"] = () => {};
  require.extensions[".png"] = (module, filename) => { module.exports = { src: filename, width: 1200, height: 800 }; };
  mock.module("server-only", { exports: {} });
  mock.module("./src/lib/marketing/fonts.ts", { namedExports: { marketingFontClasses: async () => "" } });
`

// Render the real components with the real React runtime. A small hook dispatcher
// retains local state while actual element handlers run without a browser install.
// This proves staging/request behavior; it does not claim DOM focus or layout proof.
export const interactionSetup = `
  const React = require("react");
  const assert = require("node:assert/strict");
  const { mock } = require("node:test");
  const { renderToStaticMarkup } = require("react-dom/server");
  const calls = [], navigations = [], states = [], effects = [];
  let cursor = 0, response = async () => ({});
  global.window = { location: { href: "https://fundlane.test/sign-in?next=%2Faccept-invite%3Ftoken%3Dabcdefghijklmnopqrst", search: "", assign: url => navigations.push(url) } };
  mock.module("./src/lib/mca/client.ts", { namedExports: { requestJson: async (path, options) => { calls.push({ path, input: options?.body ? JSON.parse(options.body) : null }); return response(path); } } });
  const dispatcher = {
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return states[index] ??= { current: initial }; },
    useId() { const index = cursor++; return states[index] ??= "test-id-" + index; },
    useEffect(action, dependencies) { const index = cursor++; const previous = states[index]; if (!previous || !dependencies || dependencies.some((value, i) => value !== previous[i])) { states[index] = dependencies; effects.push(action); } },
  };
  function render(Component, props = {}) {
    cursor = 0;
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previous = internals.H;
    internals.H = dispatcher;
    let tree;
    try { tree = Component(props); } finally { internals.H = previous; }
    while (effects.length) effects.shift()();
    return { tree, markup: renderToStaticMarkup(tree) };
  }
  function nodes(tree) { if (!tree || typeof tree !== "object") return []; return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]; }
  function find(tree, predicate) { return nodes(tree).find(predicate); }
  function text(tree) { if (tree === null || tree === undefined || typeof tree === "boolean") return ""; if (typeof tree !== "object") return String(tree); return [tree.props?.children].flat(Infinity).map(text).join(""); }
  function button(tree, label) { return find(tree, node => node.type === "button" && text(node) === label); }
  function input(tree, name) { return find(tree, node => node.type === "input" && node.props.name === name); }
  function form(tree) { return find(tree, node => node.type === "form"); }
  const submit = tree => form(tree).props.onSubmit({ preventDefault() {} });
`
