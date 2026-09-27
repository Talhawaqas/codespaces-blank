// src/lib/mlStudio/catalog.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream B governance slice, §"data catalog
// (general, spanning datasets/tables/models/analyzers)". A catalog entry is METADATA that points at a source
// that already exists elsewhere in this codebase -- it never stores a copy of the data, and registration
// VERIFIES the reference resolves to something real before accepting it, so the catalog can never accumulate
// dangling entries. Three source types, each an existing seam:
//   TABLE             -> legacyDataAccess's virtual table (an existing, already-published SQL source)
//   ANALYZER          -> a Document Intelligence analyzer (docIntelligence/analyzers.js)
//   DOCUMENT_PROJECT  -> an org_documents project (the existing 3-level document hierarchy)

import { toObjectId, canManageOrg } from "../orgs.js";
import { getVirtualTableByName } from "../legacyDataAccess/metadata.js";
import { getAnalyzer } from "../docIntelligence/analyzers.js";
import { getMlStudioCollections, ensureMlStudioIndexes } from "./db.js";
import { fail, nowIso } from "../docIntelligence/common.js";
import { event } from "./record.js";

export const CATALOG_TYPES = ["TABLE", "ANALYZER", "DOCUMENT_PROJECT"];
export const entryView = (e) => ({ catalogId: String(e._id), key: e.key, name: e.name, description: e.description || "", type: e.type, ref: e.ref, tags: e.tags || [], createdAt: e.createdAt, updatedAt: e.updatedAt, createdBy: e.createdBy });

async function verifyRef({ orgId, type, ref }) {
  if (type === "TABLE") {
    if (!ref?.dataSourceId || !ref?.tableName) return "TABLE requires ref.dataSourceId and ref.tableName.";
    const t = await getVirtualTableByName({ orgId, dataSourceId: ref.dataSourceId, tableName: ref.tableName }).catch(() => null);
    if (!t) return `No published virtual table "${ref.tableName}" was found on that data source.`;
    return null;
  }
  if (type === "ANALYZER") {
    if (!ref?.analyzerId) return "ANALYZER requires ref.analyzerId.";
    const a = await getAnalyzer({ orgId, analyzerId: ref.analyzerId });
    if (!a) return "No analyzer with that id was found.";
    return null;
  }
  if (type === "DOCUMENT_PROJECT") {
    if (!ref?.projectId) return "DOCUMENT_PROJECT requires ref.projectId.";
    const { getOrgCollections } = await import("../orgs.js");
    const { projects } = await getOrgCollections();
    const p = await projects.findOne({ _id: toObjectId(ref.projectId), orgId: toObjectId(orgId) });
    if (!p) return "No project with that id was found in this organization.";
    return null;
  }
  return `Unknown catalog type "${type}".`;
}

export async function registerCatalogEntry({ orgId, membership, actorEmail, name, description = "", type, ref, tags = [] }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can register a catalog entry.", 403);
  if (!name || name.length > 120) return fail("name is required (max 120 characters).");
  if (!CATALOG_TYPES.includes(type)) return fail(`type must be one of ${CATALOG_TYPES.join(", ")}.`);
  const refError = await verifyRef({ orgId, type, ref });
  if (refError) return fail(refError, 400);
  await ensureMlStudioIndexes();
  const c = await getMlStudioCollections();
  const key = `${type.toLowerCase()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60)}-${Date.now().toString(36)}`;
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), key, name, description: String(description).slice(0, 500), type, ref, tags: (Array.isArray(tags) ? tags : []).slice(0, 20).map((t) => String(t).slice(0, 40)), createdAt: now, updatedAt: now, createdBy: actorEmail };
  doc._id = (await c.mlCatalog.insertOne(doc)).insertedId;
  await event({ orgId, type: "CATALOG_ENTRY_REGISTERED", recordId: doc._id, actorEmail, metadata: { key, type: doc.type, name } });
  return { entry: entryView(doc) };
}

export async function listCatalog({ orgId, type = null }) {
  const c = await getMlStudioCollections();
  const q = { orgId: toObjectId(orgId) }; if (type) q.type = type;
  return { entries: (await c.mlCatalog.find(q).sort({ createdAt: -1 }).toArray()).map(entryView) };
}

export async function getCatalogEntry({ orgId, catalogId }) {
  let oid; try { oid = toObjectId(catalogId); } catch { return null; }
  const c = await getMlStudioCollections();
  return c.mlCatalog.findOne({ _id: oid, orgId: toObjectId(orgId) });
}
