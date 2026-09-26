// scripts/workflow-worker.mjs
//
// Standalone worker for the AI Business Operations Manager:
//   node --env-file=.env.local scripts/workflow-worker.mjs           # loop, every 30s
//   node --env-file=.env.local scripts/workflow-worker.mjs --once    # one pass
// Every step is idempotent (see src/lib/workflows/runner.js), so running it from more than one place, or
// restarting it mid-pass, never duplicates an execution, a notification or an approval request.
import { runWorkflowWorker } from "../src/lib/workflows/runner.js";
import { ensureOrgIndexes } from "../src/lib/orgs.js";

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.WORKFLOW_WORKER_INTERVAL_MS || 30000);
await ensureOrgIndexes();
do {
  try {
    const r = await runWorkflowWorker({});
    console.log(new Date().toISOString(), "workflow worker pass", JSON.stringify({ fired: r.schedules.fired, refused: r.schedules.refused, executions: r.executions, ms: r.elapsedMs }));
  } catch (e) {
    console.error("workflow worker pass failed:", e.message);
  }
  if (once) break;
  await new Promise((res) => setTimeout(res, intervalMs));
} while (true);
process.exit(0);
