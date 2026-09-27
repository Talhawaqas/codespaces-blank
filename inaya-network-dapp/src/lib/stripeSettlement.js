// src/lib/stripeSettlement.js
//
// SQA-007 (S1): Stripe delivers checkout.session.completed at least once, and retries on timeouts and 5xx. The Corporate Reserve and
// PAYG settlements spend the treasury wallet on-chain, so a retried delivery used to run the whole settlement again (a second
// processCorporateInvoice + createEscrow for one payment). Every on-chain settlement now first ATOMICALLY claims its Stripe session id;
// only the claim holder settles. A failed settlement is released for Stripe's retry; one stuck "processing" (the process died, so the
// chain state is unknown) is never re-run automatically -- an operator must reconcile it.

import { connectToDatabase } from "./mongodb.js";

const COLLECTION = "stripe_settlements";
let indexed = false;
async function collection() {
  const { db } = await connectToDatabase();
  const c = db.collection(COLLECTION);
  if (!indexed) { await c.createIndex({ status: 1, updatedAt: 1 }); indexed = true; }
  return c;
}

/** @returns {{ claimed: true } | { claimed: false, status: string, result?: object }} */
export async function claimSettlement(sessionId, type) {
  const c = await collection(); const now = new Date();
  try {
    await c.insertOne({ _id: sessionId, type, status: "processing", attempts: 1, createdAt: now, updatedAt: now });
    return { claimed: true };
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  // an earlier attempt exists: only a FAILED one (settlement threw before completing) may be retried, and only by one caller
  const retry = await c.findOneAndUpdate({ _id: sessionId, status: "failed" }, { $set: { status: "processing", updatedAt: now }, $inc: { attempts: 1 } });
  if (retry) return { claimed: true };
  const existing = await c.findOne({ _id: sessionId });
  return { claimed: false, status: existing?.status || "unknown", result: existing?.result };
}

/** The on-chain steps a previous (failed) attempt already completed, so a retry resumes instead of repeating them. */
export async function getProgress(sessionId) {
  const c = await collection();
  return (await c.findOne({ _id: sessionId }, { projection: { progress: 1 } }))?.progress || {};
}

export async function recordProgress(sessionId, patch) {
  const c = await collection();
  const set = {}; for (const [k, v] of Object.entries(patch)) set[`progress.${k}`] = v;
  await c.updateOne({ _id: sessionId }, { $set: { ...set, updatedAt: new Date() } });
}

export async function completeSettlement(sessionId, result) {
  const c = await collection();
  await c.updateOne({ _id: sessionId }, { $set: { status: "completed", result: result || null, completedAt: new Date(), updatedAt: new Date() } });
}

export async function failSettlement(sessionId, error) {
  const c = await collection();
  await c.updateOne({ _id: sessionId }, { $set: { status: "failed", error: String(error?.message || error).slice(0, 500), updatedAt: new Date() } });
}
