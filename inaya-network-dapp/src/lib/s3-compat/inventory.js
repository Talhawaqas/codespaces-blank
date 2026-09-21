// src/lib/s3-compat/inventory.js
//
// AWS S3 Feature Expansion SOW, Phase 2 -- Storage Inventory. Genuinely
// missing per the Phase 0 audit (no cross-bucket/org export existed
// beyond single-bucket ListObjectsV2). Read-only: builds a report from
// records that already exist (org_documents), same "existing records,
// not a second inventory database" discipline as evidenceExporter.js.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { listS3Buckets, getS3Bucket } from "./store.js";

/** One row per live object (isLatest only, matching what an ordinary
 *  ListObjectsV2 would show -- older versions are covered by the existing
 *  ?versions API, not duplicated here). */
export async function buildStorageInventory({ orgId, bucket }) {
  const { orgDocuments, projects } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);

  let bucketDocs;
  if (bucket) {
    const b = await getS3Bucket({ orgId, bucket });
    if (!b) throw new Error("NoSuchBucket");
    bucketDocs = [b];
  } else {
    const buckets = await listS3Buckets(orgId);
    const all = await projects.find({ orgId: orgObjectId, name: { $in: buckets.map((b) => b.name) } }).toArray();
    bucketDocs = all;
  }
  const bucketNameById = new Map(bucketDocs.map((b) => [b._id.toString(), b.name]));

  const objects = await orgDocuments
    .find({ orgId: orgObjectId, projectId: { $in: bucketDocs.map((b) => b._id) }, isLatest: { $ne: false }, deletedAt: null })
    .sort({ filename: 1 })
    .toArray();

  const rows = objects.map((o) => ({
    bucket: bucketNameById.get(o.projectId.toString()) || null,
    key: o.filename,
    sizeBytes: o.sizeBytes ?? 0,
    contentType: o.contentType || null,
    contentSha256: o.contentSha256 || null,
    tags: o.tags || {},
    versionId: o.versionId || null,
    versioningApplicable: o.versionId && o.versionId !== "null",
    retentionMode: o.retentionMode || null,
    retentionUntil: o.retentionUntil || null,
    legalHold: !!o.legalHold,
    lastModified: o.createdAt,
  }));

  return {
    generatedAt: new Date().toISOString(),
    orgId: orgId.toString(),
    bucketScope: bucket || "all buckets",
    objectCount: rows.length,
    totalSizeBytes: rows.reduce((sum, r) => sum + r.sizeBytes, 0),
    objects: rows,
  };
}

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderInventoryCsv(inventory) {
  const headers = ["bucket", "key", "sizeBytes", "contentType", "contentSha256", "tags", "versionId", "retentionMode", "retentionUntil", "legalHold", "lastModified"];
  const lines = [headers.join(",")];
  for (const o of inventory.objects) {
    lines.push(
      headers
        .map((h) => (h === "tags" ? csvEscape(JSON.stringify(o.tags)) : csvEscape(o[h])))
        .join(",")
    );
  }
  return lines.join("\n");
}
