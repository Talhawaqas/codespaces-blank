// src/lib/bookkeeper/worker.js
//
// AI Bookkeeper SOW sections 39-41: the periodic safety-net pass (cron every 15 minutes). Scheduled DAILY work belongs to the existing
// workflow engine (Finance Operations Manager template); this pass only makes sure nothing is stuck:
//   1. documents that stayed NEEDS_REVIEW only because the AI model was unavailable are re-tried (max 3 attempts, then left for a person);
//   2. bank-feed provider syncs that failed are retried (no provider is registered today, so this is a no-op until one is);
//   3. matches whose target has since been settled in the authoritative record become RECONCILED.
// Every step is idempotent and isolated; a failure in one never stops the others, and nothing here changes an authoritative record.

import { getBookkeeperCollections, ensureBookkeeperIndexes } from "./db.js";
import { reprocessDocument } from "./documents.js";
import { syncSource } from "./bank.js";
import { sweepSettled } from "./reconcile.js";
import { nowIso } from "./common.js";

const MAX_RETRIES = 3;
async function step(name, out, fn) { try { out[name] = await fn(); } catch (e) { console.error(`bookkeeper worker step ${name} failed:`, e); out[name] = { error: String(e.message || e).slice(0, 200) }; } }

export async function retryAiDocuments({ limit = 10 } = {}) {
  const { bkDocuments } = await getBookkeeperCollections(); const out = { tried: 0, improved: 0 };
  const rows = await bkDocuments.find({ status: "NEEDS_REVIEW", warnings: { $elemMatch: { $regex: /AI extraction unavailable/ } }, aiRetries: { $not: { $gte: MAX_RETRIES } } }).sort({ updatedAt: 1 }).limit(limit).toArray();
  for (const d of rows) {
    const claim = await bkDocuments.updateOne({ _id: d._id, aiRetries: d.aiRetries || 0 }, { $inc: { aiRetries: 1 } }); if (!claim.modifiedCount) continue;
    out.tried++;
    const r = await reprocessDocument({ orgId: d.orgId, documentId: d._id, actor: "bookkeeper-worker" });
    if (!r.error && (r.document.extractionConfidence ?? 0) > (d.extractionConfidence ?? 0)) out.improved++;
  }
  return out;
}

export async function retryFailedSyncs() {
  const { bkSources } = await getBookkeeperCollections(); const out = { tried: 0, synced: 0 };
  const rows = await bkSources.find({ status: "ACTIVE", type: "BANK_ACCOUNT", lastSyncStatus: "FAILED", provider: { $nin: [null, "file"] } }).limit(20).toArray();
  for (const s of rows) { out.tried++; const r = await syncSource({ orgId: s.orgId, source: s, actor: "bookkeeper-worker" }); if (!r.error) out.synced++; }
  return out;
}

export async function settleAll() {
  const { bkMatches } = await getBookkeeperCollections(); const orgs = await bkMatches.distinct("orgId", { status: { $in: ["AUTO_MATCHED", "CONFIRMED"] } }); let reconciled = 0;
  for (const o of orgs.slice(0, 200)) reconciled += (await sweepSettled({ orgId: o, actor: "bookkeeper-worker" })).reconciled;
  return { orgs: orgs.length, reconciled };
}

export async function runBookkeeperWorker() {
  await ensureBookkeeperIndexes(); const out = { at: nowIso() };
  await step("aiRetries", out, () => retryAiDocuments());
  await step("bankSyncs", out, () => retryFailedSyncs());
  await step("settled", out, () => settleAll());
  return out;
}
