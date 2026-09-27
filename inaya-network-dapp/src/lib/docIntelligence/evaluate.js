// src/lib/docIntelligence/evaluate.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream C, §"evaluation (precision/recall/field
// accuracy/grounding rate/correction rate -- never a single opaque AI score)". An evaluation run compares an
// analyzer's already-produced results against a labeled sample set (the expected field values a human
// supplies) and reports each metric separately -- never collapsed into one score, per the SOW's own wording.

import { toObjectId } from "../orgs.js";
import { getDocIntelligenceCollections } from "./db.js";
import { fail, nowIso, round4 } from "./common.js";
import { currentFields } from "./review.js";
import { event } from "./record.js";

const near = (a, b) => { const x = Number(a), y = Number(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) <= Math.max(0.01, Math.abs(y) * 0.005) : false; };
const eq = (type, a, b) => {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  if (type === "number" || type === "currency") return type === "currency" ? String(a).toUpperCase() === String(b).toUpperCase() : near(a, b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
};

/**
 * `samples`: [{ resultId, expectedFields: { fieldName: value } }] for EXTRACT analyzers, or
 * [{ resultId, expectedLabel }] for CLASSIFY. Field-level precision/recall treat "analyzer produced a value
 * for this field" as a positive prediction and "the label sheet expects a value for this field" as ground truth.
 */
export async function runEvaluation({ orgId, analyzerKey, fieldSchema = null, samples, actorEmail }) {
  if (!Array.isArray(samples) || !samples.length) return fail("At least one labeled sample is required.");
  if (samples.length > 500) return fail("At most 500 samples per evaluation run.");
  const c = await getDocIntelligenceCollections(); const oid = toObjectId(orgId);
  let tp = 0, fp = 0, fn = 0, correctFields = 0, totalExpectedFields = 0, groundedCount = 0, valuedCount = 0, correctedResults = 0, evaluatedResults = 0;
  const perSample = [];

  for (const s of samples.slice(0, 500)) {
    let rid; try { rid = toObjectId(s.resultId); } catch { continue; }
    const result = await c.diResults.findOne({ _id: rid, orgId: oid, analyzerKey });
    if (!result) { perSample.push({ resultId: s.resultId, error: "not found" }); continue; }
    evaluatedResults++;
    if ((result.corrections || []).length) correctedResults++;
    const fields = currentFields(result);
    for (const [name, val] of Object.entries(fields)) { valuedCount++; if (val.grounded) groundedCount++; }

    if (result.method === "CLASSIFY" && s.expectedLabel) {
      const predicted = result.classification?.label;
      const correct = predicted === s.expectedLabel;
      if (correct) tp++; else { fp++; fn++; }
      perSample.push({ resultId: s.resultId, correct });
      continue;
    }
    if (s.expectedFields && typeof s.expectedFields === "object") {
      const schema = fieldSchema || [];
      const typeOf = (name) => schema.find((f) => f.name === name)?.type || "string";
      const expectedNames = Object.keys(s.expectedFields);
      const predictedNames = Object.keys(fields);
      totalExpectedFields += expectedNames.length;
      let sampleCorrect = 0;
      for (const name of expectedNames) { if (eq(typeOf(name), fields[name]?.value, s.expectedFields[name])) { correctFields++; sampleCorrect++; } }
      for (const name of expectedNames) predictedNames.includes(name) ? tp++ : fn++;
      for (const name of predictedNames) if (!expectedNames.includes(name)) fp++;
      perSample.push({ resultId: s.resultId, correctFields: sampleCorrect, expectedFields: expectedNames.length });
    }
  }

  const precision = tp + fp > 0 ? round4(tp / (tp + fp)) : null;
  const recall = tp + fn > 0 ? round4(tp / (tp + fn)) : null;
  const fieldAccuracy = totalExpectedFields > 0 ? round4(correctFields / totalExpectedFields) : null;
  const groundingRate = valuedCount > 0 ? round4(groundedCount / valuedCount) : null;
  const correctionRate = evaluatedResults > 0 ? round4(correctedResults / evaluatedResults) : null;
  const metrics = { precision, recall, fieldAccuracy, groundingRate, correctionRate, sampleCount: samples.length, evaluatedResults };

  const now = nowIso();
  const run = { orgId: oid, analyzerKey, metrics, perSample: perSample.slice(0, 500), createdAt: now, createdBy: actorEmail };
  run._id = (await c.diEvaluations.insertOne(run)).insertedId;
  await event({ orgId, type: "EVALUATION_RUN", recordId: run._id, actorEmail, metadata: { analyzerKey, ...metrics } });
  return { evaluationId: String(run._id), analyzerKey, metrics, createdAt: now };
}

export async function listEvaluations({ orgId, analyzerKey = null, limit = 20 }) {
  const c = await getDocIntelligenceCollections();
  const q = { orgId: toObjectId(orgId) }; if (analyzerKey) q.analyzerKey = analyzerKey;
  const items = await c.diEvaluations.find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).toArray();
  return items.map((r) => ({ evaluationId: String(r._id), analyzerKey: r.analyzerKey, metrics: r.metrics, createdAt: r.createdAt }));
}
