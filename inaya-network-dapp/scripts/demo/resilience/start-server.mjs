// scripts/demo/resilience/start-server.mjs -- runs the demo: the production build of the app on http://127.0.0.1:3003 and the NAS
// worker (as it would run on the customer's network), both in the isolated environment from _env.mjs.
//   NEXT_DIST_DIR=.next-prod npx next build                                  # once, after code changes
//   node --env-file=.env.local scripts/demo/resilience/start-server.mjs
// Stops both on Ctrl+C. Set RESILIENCE_DEMO_NO_WORKER=1 to run without the NAS worker (e.g. to show what happens when it is off).
import { DEMO_ENV } from "./_env.mjs";
import { DEMO_PORT } from "./_common.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".next-prod/BUILD_ID")) { console.error("No production build in .next-prod. Run: NEXT_DIST_DIR=.next-prod npx next build"); process.exit(1); }
const env = { ...process.env, ...DEMO_ENV, NEXT_DIST_DIR: ".next-prod", PORT: String(DEMO_PORT), NODE_ENV: "production" };
const kids = [];
const start = (name, cmd, args, extra = {}) => {
  const p = spawn(cmd, args, { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && cmd === "npx" });
  p.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`)); p.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  p.on("exit", (code) => { console.log(`[${name}] exited ${code}`); if (name === "web") shutdown(); });
  kids.push(p); return p;
};
function shutdown() { for (const k of kids) { try { k.kill(); } catch { /* gone */ } } process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);

console.log(`Enterprise Resilience demo: http://127.0.0.1:${DEMO_PORT} (TEST database, local storage, e-mail off)`);
start("web", "npx", ["next", "start", "-p", String(DEMO_PORT), "-H", "127.0.0.1"]);
if (process.env.RESILIENCE_DEMO_NO_WORKER !== "1") start("nas-worker", process.execPath, ["--import", "./test/_next-loader.mjs", "scripts/nas-worker.mjs"], { NAS_WORKER_INTERVAL_MS: "60000" });
