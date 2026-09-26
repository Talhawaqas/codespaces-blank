// scripts/nas-worker.mjs
//
// Standalone NAS worker for the host that runs next to the appliance:
//   node --env-file=.env.local scripts/nas-worker.mjs            # loop, every 60s
//   node --env-file=.env.local scripts/nas-worker.mjs --once     # one pass
// Each pass is idempotent (see src/lib/nas/runner.js), so running it from more
// than one place, or restarting it mid-pass, never duplicates work.
import { runNasWorker } from "../src/lib/nas/runner.js";
import { NasAgentClient } from "../src/lib/nas/agent.js";
import { ensureOrgIndexes } from "../src/lib/orgs.js";

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.NAS_WORKER_INTERVAL_MS || 60000);
// WSL2 stops its VM when idle (unmounting pools); a physical appliance does not.
if (process.env.NAS_WSL_KEEPALIVE !== "0") NasAgentClient.startKeepAlive();
await ensureOrgIndexes();
do {
  try {
    const r = await runNasWorker({});
    console.log(new Date().toISOString(), "nas worker pass", JSON.stringify({ jobs: r.jobs?.processed ?? 0, ms: r.elapsedMs }));
  } catch (e) {
    console.error("nas worker pass failed:", e.message);
  }
  if (once) break;
  await new Promise((res) => setTimeout(res, intervalMs));
} while (true);
process.exit(0);
