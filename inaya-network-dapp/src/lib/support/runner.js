// src/lib/support/runner.js
//
// One worker pass for everything time-driven in support: SLA clocks and escalations, auto-close of solved tickets,
// AI triage retries, outbound webhook deliveries/retries, retention. Called by /api/cron/support every 5 minutes
// (vercel.json) and safe to call from any number of workers at once: each step is idempotent (unique ledgers,
// optimistic concurrency, claim-by-update). A failing step never stops the others.

import { processSlaTick } from "./slaTick.js";
import { processDeliveries } from "./webhooks.js";
import { retryPendingTriage } from "./ai.js";
import { runRetention } from "./retention.js";
import { ensureSupportIndexes } from "./db.js";

export async function runSupportWorker({ now = Date.now() } = {}) {
  await ensureSupportIndexes();
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (err) { console.error(`support worker step ${name} failed:`, err.message); out[name] = { error: true }; } };
  await step("sla", () => processSlaTick({ now }));
  await step("triage", () => retryPendingTriage({ now }));
  await step("webhooks", () => processDeliveries({}));
  await step("retention", () => runRetention({ now }));
  return out;
}
