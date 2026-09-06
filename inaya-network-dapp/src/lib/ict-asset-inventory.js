// src/lib/ict-asset-inventory.js
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§67) — ICT
// Asset Inventory. Cross-vertical (every org has ICT assets, not just a
// financial one). "Particularly important for operational-resilience
// frameworks such as DORA, which require identification, classification
// and documentation of ICT-supported functions, information assets, ICT
// assets and third-party dependencies" (§67) — dependencies is therefore
// a first-class field (an array of other asset IDs), not an afterthought,
// so operational-resilience.js can actually walk the dependency graph
// rather than just listing assets in isolation.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const ICT_ASSET_TYPES = ["application", "server", "endpoint", "database", "saas", "api", "network", "cloud_resource", "data_store", "third_party_dependency"];
export const ICT_ASSET_CRITICALITY = ["low", "medium", "high", "critical"];
export const ICT_ASSET_ENVIRONMENTS = ["production", "staging", "development", "test"];

export async function createIctAsset({ orgId, name, type, criticality, environment, location, dataClassification, ownerEmail, dependencies, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can register an ICT asset.", status: 403 };
  if (!name?.trim()) return { error: "An asset name is required.", status: 400 };
  if (!ICT_ASSET_TYPES.includes(type)) return { error: `Unknown asset type "${type}".`, status: 400 };
  if (criticality && !ICT_ASSET_CRITICALITY.includes(criticality)) return { error: `Unknown criticality "${criticality}".`, status: 400 };
  if (environment && !ICT_ASSET_ENVIRONMENTS.includes(environment)) return { error: `Unknown environment "${environment}".`, status: 400 };

  const { ictAssets } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name: name.trim(), type, criticality: criticality || "medium",
    environment: environment || "production", location: location || null, dataClassification: dataClassification || null,
    ownerEmail: ownerEmail || actorEmail, dependencies: (dependencies || []).map((id) => toObjectId(id)),
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await ictAssets.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "ICT_ASSET", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { name: doc.name, type } });
  return { asset: inserted };
}

export async function updateIctAsset({ orgId, assetId, updates, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update an ICT asset.", status: 403 };
  const { ictAssets } = await getOrgCollections();
  const allowed = ["criticality", "environment", "location", "dataClassification", "ownerEmail"];
  const setDoc = { updatedAt: new Date().toISOString() };
  for (const key of allowed) if (updates[key] !== undefined) setDoc[key] = updates[key];
  if (updates.dependencies !== undefined) setDoc.dependencies = updates.dependencies.map((id) => toObjectId(id));

  const updated = await ictAssets.findOneAndUpdate(
    { _id: toObjectId(assetId), orgId: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "ICT asset not found.", status: 404 };
  return { asset: updated };
}

/** Walks one level of the dependency graph -- returns the asset plus the
 *  assets it depends on, never a fabricated transitive closure (a real
 *  DORA-style dependency map should be walked explicitly by the caller,
 *  not silently flattened into a single list that hides cycles/depth). */
export async function getAssetWithDependencies(orgId, assetId) {
  const { ictAssets } = await getOrgCollections();
  const asset = await ictAssets.findOne({ _id: toObjectId(assetId), orgId: toObjectId(orgId) });
  if (!asset) return null;
  const dependencies = asset.dependencies.length > 0 ? await ictAssets.find({ _id: { $in: asset.dependencies }, orgId: toObjectId(orgId) }).toArray() : [];
  return { asset, dependencies };
}

export async function listIctAssets(orgId, { type, criticality, environment } = {}) {
  const { ictAssets } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (type) query.type = type;
  if (criticality) query.criticality = criticality;
  if (environment) query.environment = environment;
  return ictAssets.find(query).sort({ name: 1 }).toArray();
}
