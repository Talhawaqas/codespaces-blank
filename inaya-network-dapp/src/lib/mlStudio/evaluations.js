// src/lib/mlStudio/evaluations.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream B governance slice. An evaluation run
// records a named metrics object the caller already computed (offline, or via docIntelligence's own
// evaluate.js for a document-analysis model) -- never a single opaque "AI score", per the SOW's own wording.
// Linked to the model version as a real Evidence Graph relationship (CHECKED_BY), not a free-text log line.

import { toObjectId, canManageOrg } from "../orgs.js";
import { getMlStudioCollections, ensureMlStudioIndexes } from "./db.js";
import { getModel, modelView } from "./models.js";
import { fail, nowIso } from "../docIntelligence/common.js";
import { event, link } from "./record.js";

const MAX_METRICS = 30;
export const evalView = (e) => ({ evaluationId: String(e._id), modelId: String(e.modelId), metrics: e.metrics, notes: e.notes || "", createdAt: e.createdAt, createdBy: e.createdBy });

export async function recordEvaluation({ orgId, membership, actorEmail, modelId, metrics, notes = "" }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can record an evaluation.", 403);
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return fail("metrics must be an object of named metric values.");
  const entries = Object.entries(metrics).slice(0, MAX_METRICS).filter(([, v]) => typeof v === "number" && Number.isFinite(v));
  if (!entries.length) return fail("At least one numeric metric is required.");
  const m = await getModel({ orgId, modelId }); if (!m) return fail("Model version not found.", 404);
  await ensureMlStudioIndexes();
  const c = await getMlStudioCollections();
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), modelId: m._id, metrics: Object.fromEntries(entries), notes: String(notes).slice(0, 1000), createdAt: now, createdBy: actorEmail };
  doc._id = (await c.mlEvaluations.insertOne(doc)).insertedId;
  await event({ orgId, type: "EVALUATION_RUN", recordId: doc._id, actorEmail, metadata: { modelId: String(m._id), modelName: m.modelName, version: m.version, ...Object.fromEntries(entries) } });
  link({ orgId, subjectId: m._id, type: "CHECKED_BY", targetType: "ML_EVALUATION", targetId: doc._id, note: entries.map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 200) });
  return { evaluation: evalView(doc) };
}

export async function listEvaluations({ orgId, modelId, limit = 20 }) {
  const c = await getMlStudioCollections();
  const evaluations = await c.mlEvaluations.find({ orgId: toObjectId(orgId), modelId: toObjectId(modelId) }).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).toArray();
  return { evaluations: evaluations.map(evalView) };
}
