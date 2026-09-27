// src/lib/mlStudio/models.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream B governance slice, §"model registry /
// versioning / evaluation / artifact integrity". Inaya has no training compute (see the capability audit), so
// a "model" here is metadata plus an artifact the caller already produced elsewhere and uploads for the
// registry to version, hash, and govern -- exactly what the audit classified as GENUINE GAP / buildable now
// ("this is metadata plus storage plus hashing, not new compute"). Artifact storage reuses the SAME encrypted,
// sharded, multi-provider store as every other feature (s3-compat/store.js) -- not a second storage engine.

import { toObjectId, canManageOrg } from "../orgs.js";
import { getS3ObjectBody, putS3Object } from "../s3-compat/store.js";
import { ensureOwnerS3Passphrase } from "../s3-compat/credentials.js";
import { listAvailableProviders } from "../pinningProviders/index.js";
import { getMlStudioCollections, ensureMlStudioIndexes } from "./db.js";
import { getCatalogEntry } from "./catalog.js";
import { fail, nowIso, sha256, safeFilename, ANALYZER_STATUSES, ANALYZER_TRANSITIONS } from "../docIntelligence/common.js";
import { event, link, notify } from "./record.js";

const BUCKET = "ml-model-artifacts";
const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

async function storeArtifact({ orgId, key, buffer, contentType, actor }) {
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  const configured = listAvailableProviders();
  const attempts = configured.length ? [...configured].sort((a, b) => (a === "pinata" ? -1 : b === "pinata" ? 1 : 0)) : [undefined];
  let last;
  for (const providerName of attempts) {
    try { return await putS3Object({ orgId: String(orgId), bucket: BUCKET, key, bodyBuffer: buffer, contentType, actorEmail: actor || "ml-studio", providerName }); }
    catch (err) { last = err; console.error(`ml-studio artifact storage: provider "${providerName || "default"}" failed (${String(err.message).slice(0, 100)})`); }
  }
  throw last;
}

export const modelView = (m) => ({ modelId: String(m._id), modelName: m.modelName, version: m.version, framework: m.framework || null, description: m.description || "", status: m.status, artifact: m.artifact ? { filename: m.artifact.filename, sizeBytes: m.artifact.sizeBytes, sha256: m.artifact.sha256, contentType: m.artifact.contentType } : null, datasetCatalogIds: (m.datasetCatalogIds || []).map(String), createdAt: m.createdAt, updatedAt: m.updatedAt, createdBy: m.createdBy });

/**
 * Registers a new model VERSION. `datasetCatalogIds` (optional): existing ml_catalog entries this version was
 * evaluated/trained against elsewhere -- recorded as real DERIVED_FROM lineage, not a free-text note.
 */
export async function registerModel({ orgId, membership, actorEmail, modelName, version, framework = null, description = "", datasetCatalogIds = [], artifactBuffer, artifactFilename, artifactContentType }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can register a model.", 403);
  if (!modelName || modelName.length > 120) return fail("modelName is required (max 120 characters).");
  if (!version || !/^[0-9A-Za-z_.\-]{1,40}$/.test(version)) return fail("version is required (letters, digits, dots, dashes, max 40 chars).");
  if (!Buffer.isBuffer(artifactBuffer) || !artifactBuffer.length) return fail("An artifact file is required.");
  if (artifactBuffer.length > MAX_ARTIFACT_BYTES) return fail(`Artifacts can be at most ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB.`, 413);

  await ensureMlStudioIndexes();
  const c = await getMlStudioCollections(); const oid = toObjectId(orgId);
  const dup = await c.mlModelVersions.findOne({ orgId: oid, modelName, version });
  if (dup) return fail("This model name and version already exists.", 409);

  const catalogIds = [];
  for (const id of (Array.isArray(datasetCatalogIds) ? datasetCatalogIds : []).slice(0, 20)) {
    const entry = await getCatalogEntry({ orgId, catalogId: id });
    if (!entry) return fail(`Catalog entry ${id} was not found.`, 404);
    catalogIds.push(entry._id);
  }

  const hash = sha256(artifactBuffer);
  const key = `${hash.slice(0, 2)}/${hash}/${safeFilename(artifactFilename)}`;
  let stored;
  try { stored = await storeArtifact({ orgId, key, buffer: artifactBuffer, contentType: artifactContentType, actor: actorEmail }); }
  catch (err) { console.error("ml-studio artifact storage failed:", err.message); return fail("The artifact could not be stored right now. Please retry.", 502); }

  const now = nowIso();
  const doc = { orgId: oid, modelName, version, framework, description: String(description).slice(0, 1000), status: "DRAFT", datasetCatalogIds: catalogIds, artifact: { bucket: BUCKET, key, filename: safeFilename(artifactFilename), sizeBytes: artifactBuffer.length, sha256: hash, contentType: artifactContentType, versionId: stored?.versionId || null }, createdAt: now, updatedAt: now, createdBy: actorEmail };
  doc._id = (await c.mlModelVersions.insertOne(doc)).insertedId;
  await event({ orgId, type: "MODEL_REGISTERED", recordId: doc._id, actorEmail, metadata: { modelName, version, sha256: hash, sizeBytes: artifactBuffer.length } });
  for (const catId of catalogIds) link({ orgId, subjectId: doc._id, type: "DERIVED_FROM", targetType: "ML_CATALOG_ENTRY", targetId: catId, note: "dataset used for this model version" });
  notify({ orgId, title: "Model version registered", body: `${modelName} v${version} was registered by ${actorEmail}.`, dedupeKey: `mlstudio:model:${doc._id}`, severity: "info", recordId: doc._id });
  return { model: modelView(doc) };
}

export async function listModels({ orgId, modelName = null, status = null }) {
  const c = await getMlStudioCollections();
  const q = { orgId: toObjectId(orgId) }; if (modelName) q.modelName = modelName; if (status) q.status = status;
  return { models: (await c.mlModelVersions.find(q).sort({ createdAt: -1 }).toArray()).map(modelView) };
}

export async function getModel({ orgId, modelId }) {
  let oid; try { oid = toObjectId(modelId); } catch { return null; }
  const c = await getMlStudioCollections();
  return c.mlModelVersions.findOne({ _id: oid, orgId: toObjectId(orgId) });
}

export async function setModelStatus({ orgId, membership, actorEmail, modelId, status }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can change a model's status.", 403);
  if (!ANALYZER_STATUSES.includes(status)) return fail(`status must be one of ${ANALYZER_STATUSES.join(", ")}.`);
  const m = await getModel({ orgId, modelId }); if (!m) return fail("Model version not found.", 404);
  if (!ANALYZER_TRANSITIONS[m.status].includes(status)) return fail(`Cannot move a model from ${m.status} to ${status}.`, 409);
  const c = await getMlStudioCollections();
  await c.mlModelVersions.updateOne({ _id: m._id }, { $set: { status, updatedAt: nowIso() } });
  await event({ orgId, type: "MODEL_STATUS_CHANGED", recordId: m._id, actorEmail, previousState: { status: m.status }, newState: { status }, metadata: { modelName: m.modelName, version: m.version } });
  return { model: modelView({ ...m, status }) };
}

export async function downloadArtifact({ orgId, modelId }) {
  const m = await getModel({ orgId, modelId }); if (!m) return fail("Model version not found.", 404);
  const buffer = await getS3ObjectBody({ orgId: String(orgId), bucket: m.artifact.bucket, key: m.artifact.key });
  return { buffer, filename: m.artifact.filename, contentType: m.artifact.contentType };
}
