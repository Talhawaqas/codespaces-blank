// src/lib/s3-compat/analytics.js
//
// AWS S3 Feature Expansion SOW, Phase 11 -- Storage Analytics. Per the
// Phase 0 audit, orgPlans.js's getOrgUsage() already gives an org-wide
// total-bytes number (reused as-is, not recomputed here) but has no
// per-bucket breakdown. This file adds exactly that -- computed live from
// org_documents, never a second stored metrics table (no cron, no
// materialized view: bucket counts don't need sub-second freshness).

import { getOrgCollections, toObjectId } from "../orgs.js";
import { listS3Buckets } from "./store.js";

export async function computeS3BucketAnalytics({ orgId, bucket }) {
  const { orgDocuments, projects } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);

  const buckets = bucket ? [{ name: bucket }] : await listS3Buckets(orgId);
  const bucketDocs = await projects.find({ orgId: orgObjectId, name: { $in: buckets.map((b) => b.name) } }).toArray();

  const perBucket = [];
  for (const b of bucketDocs) {
    const objects = await orgDocuments.find({ orgId: orgObjectId, projectId: b._id, isLatest: { $ne: false }, deletedAt: null }).toArray();
    const versionedObjects = await orgDocuments.countDocuments({ orgId: orgObjectId, projectId: b._id, deletedAt: null });
    const sizes = objects.map((o) => o.sizeBytes || 0);
    const tagCounts = {};
    for (const o of objects) {
      for (const key of Object.keys(o.tags || {})) tagCounts[key] = (tagCounts[key] || 0) + 1;
    }
    perBucket.push({
      bucket: b.name,
      objectCount: objects.length,
      totalSizeBytes: sizes.reduce((a, c) => a + c, 0),
      averageSizeBytes: sizes.length ? Math.round(sizes.reduce((a, c) => a + c, 0) / sizes.length) : 0,
      largestObjects: [...objects].sort((a, b2) => (b2.sizeBytes || 0) - (a.sizeBytes || 0)).slice(0, 5).map((o) => ({ key: o.filename, sizeBytes: o.sizeBytes || 0 })),
      totalVersionCount: versionedObjects,
      lockedObjectCount: objects.filter((o) => o.retentionMode).length,
      legalHoldCount: objects.filter((o) => o.legalHold).length,
      tagDistribution: tagCounts,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    orgId: orgId.toString(),
    buckets: perBucket,
    totals: {
      objectCount: perBucket.reduce((a, b) => a + b.objectCount, 0),
      totalSizeBytes: perBucket.reduce((a, b) => a + b.totalSizeBytes, 0),
    },
  };
}
