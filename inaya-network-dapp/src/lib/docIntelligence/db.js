// src/lib/docIntelligence/db.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream C. Collections and indexes, same shape
// as bookkeeper/db.js. diAnalyzers holds the registry (built-ins are synthesized, never stored); diResults
// holds one row per analysis run; diReviewItems is the human-review queue; diEvaluations holds evaluation runs.

import { connectToDatabase } from "../mongodb.js";

const NAMES = {
  diAnalyzers: "di_analyzers",
  diResults: "di_results",
  diReviewItems: "di_review_items",
  diEvaluations: "di_evaluations",
};

export async function getDocIntelligenceCollections() {
  const { db } = await connectToDatabase();
  const out = { db };
  for (const [k, n] of Object.entries(NAMES)) out[k] = db.collection(n);
  return out;
}

let ensured = false;
export async function ensureDocIntelligenceIndexes() {
  if (ensured) return;
  const c = await getDocIntelligenceCollections();
  await Promise.all([
    c.diAnalyzers.createIndex({ orgId: 1, analyzerKey: 1 }, { unique: true }),
    c.diAnalyzers.createIndex({ orgId: 1, status: 1 }),
    c.diResults.createIndex({ orgId: 1, fingerprint: 1 }, { unique: true }),
    c.diResults.createIndex({ orgId: 1, analyzerKey: 1, createdAt: -1 }),
    c.diResults.createIndex({ orgId: 1, status: 1, createdAt: -1 }),
    c.diReviewItems.createIndex({ orgId: 1, status: 1, createdAt: -1 }),
    c.diReviewItems.createIndex({ orgId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { status: "OPEN" } }),
    c.diEvaluations.createIndex({ orgId: 1, analyzerKey: 1, createdAt: -1 }),
  ]);
  ensured = true;
}
