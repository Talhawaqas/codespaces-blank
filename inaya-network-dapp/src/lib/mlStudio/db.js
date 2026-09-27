// src/lib/mlStudio/db.js -- collections/indexes for the AI/ML Studio governance-only slice (RDS/SageMaker/
// Document Intelligence Gap Expansion SOW, Workstream B). No training compute, no notebooks here -- this is
// the catalog + data-quality + model-registry-as-metadata + evaluation + lineage layer the audit cleared as
// buildable now, over data sources that already exist elsewhere in this codebase.
import { connectToDatabase } from "../mongodb.js";

const NAMES = {
  mlCatalog: "ml_catalog",
  mlDataQualityRules: "ml_dq_rules",
  mlDataQualityRuns: "ml_dq_runs",
  mlModelVersions: "ml_model_versions",
  mlEvaluations: "ml_evaluations",
};

export async function getMlStudioCollections() {
  const { db } = await connectToDatabase();
  const out = { db };
  for (const [k, n] of Object.entries(NAMES)) out[k] = db.collection(n);
  return out;
}

let ensured = false;
export async function ensureMlStudioIndexes() {
  if (ensured) return;
  const c = await getMlStudioCollections();
  await Promise.all([
    c.mlCatalog.createIndex({ orgId: 1, key: 1 }, { unique: true }),
    c.mlCatalog.createIndex({ orgId: 1, type: 1 }),
    c.mlDataQualityRules.createIndex({ orgId: 1, catalogId: 1 }),
    c.mlDataQualityRuns.createIndex({ orgId: 1, catalogId: 1, createdAt: -1 }),
    c.mlModelVersions.createIndex({ orgId: 1, modelName: 1, version: 1 }, { unique: true }),
    c.mlModelVersions.createIndex({ orgId: 1, status: 1 }),
    c.mlEvaluations.createIndex({ orgId: 1, modelId: 1, createdAt: -1 }),
  ]);
  ensured = true;
}
