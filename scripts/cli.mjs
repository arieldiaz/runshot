#!/usr/bin/env node
// runshot — thin CLI over the walkthrough engine + gallery hub.
//
//   npx runshot setup                                   # install the Chromium browser (once)
//   npx runshot record  --config ./runshot/skills.config.json
//   npx runshot assert  --config ./runshot/skills.config.json   # CI gate: exit 1 on failure
//   npx runshot gallery [--base <dir>]                  # build the browsable HTML galleries
//   npx runshot serve   [--base <dir>] [--port <n>]     # build + serve the hub on :8080
//   npx runshot version
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "./version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);

// Run a sibling script (or arbitrary command) inheriting stdio; exit with its code.
const exec = (bin, args) => {
  const child = spawn(bin, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (e) => { console.error(String(e)); process.exit(1); });
};
const node = (script, args) => exec(process.execPath, [join(here, script), ...args]);

const HELP = `runshot v${VERSION} — visual walkthroughs of any web app

Usage:
  runshot setup                              Install the Chromium browser (run once)
  runshot record --config <file>             Capture a walkthrough (video + screens + emails + social)
  runshot assert --config <file>             Same, but exit non-zero on any failure (CI gate)
  runshot gallery [--base <dir>]             Build the browsable HTML galleries
  runshot serve   [--base <dir>] [--port n]  Build + serve the gallery hub (0.0.0.0:8080)
  runshot version                            Print the version

Config defaults to ./runshot/skills.config.json.
serve env: PORT (8080), HOST (0.0.0.0), BASE_PATH (/), PUBLIC_BASE_URL — see .env.example.
See https://github.com/arieldiaz/runshot`;

switch (cmd) {
  case "setup": exec("npx", ["playwright", "install", "chromium"]); break;
  case "record": node("walkthrough.mjs", ["--mode", "record", ...rest]); break;
  case "assert": node("walkthrough.mjs", ["--mode", "assert", ...rest]); break;
  case "gallery": node("gallery.mjs", rest); break;
  case "serve": node("gallery.mjs", ["--serve", ...rest]); break;
  case "version": case "--version": case "-v": console.log(`runshot v${VERSION}`); break;
  case undefined: case "help": case "--help": case "-h": console.log(HELP); break;
  default: console.error(`Unknown command: ${cmd}\n\n${HELP}`); process.exit(1);
}
