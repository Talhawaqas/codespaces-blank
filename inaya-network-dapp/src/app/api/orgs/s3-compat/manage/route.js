// app/api/orgs/s3-compat/manage/route.js
//
// Storj-Inspired Storage Capability Expansion SOW -- Business Workspace's
// session-authenticated management surface for the capabilities added on
// top of the S3/Azure protocol layer (buckets/objects/versions/lock/
// legal-hold/lifecycle/health). This is deliberately NOT part of the S3
// REST protocol surface itself (that's /api/s3/*, SigV4-signed, for real
// S3 tools) -- it's the same "own API, session-authenticated" pattern
// api/orgs/s3-compat/credentials/route.js already established, so
// Business Workspace never needs to hold or sign with an S3 credential
// just to manage its own storage. Owner/admin only, same gate as every
// other org-storage-admin action in this codebase.
//
// GET  ?orgId=&action=buckets
// GET  ?orgId=&action=objects&bucket=
// GET  ?orgId=&action=versions&bucket=&key=
// GET  ?orgId=&action=health&bucket=&key=&versionId=
// GET  ?orgId=&action=lifecycle&bucket=
// GET  ?orgId=&action=tags&bucket=&key=
// GET  ?orgId=&action=inventory&bucket=&format=json|csv    -- AWS S3 Feature Expansion SOW, Phase 2
// GET  ?orgId=&action=analytics&bucket=                     -- AWS S3 Feature Expansion SOW, Phase 11
// GET  ?orgId=&action=policy-analysis                       -- AWS S3 Feature Expansion SOW, Phase 9
// POST { orgId, action: "versioning"|"object-lock"|"retention"|"legal-hold"|"restore"|"lifecycle"|"lifecycle-run"|"tags"|"batch", ...}

import { NextResponse } from "next/server";
import { requireMembership, canManageOrg } from "../../../../../lib/orgs.js";
import { buildStorageInventory, renderInventoryCsv } from "../../../../../lib/s3-compat/inventory.js";
import { computeS3BucketAnalytics } from "../../../../../lib/s3-compat/analytics.js";
import { analyzeS3CredentialPolicies } from "../../../../../lib/s3-compat/policyAnalyzer.js";
import { runBatchOperation } from "../../../../../lib/s3-compat/batchOperations.js";
import * as store from "../../../../../lib/s3-compat/store.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId");
    const action = url.searchParams.get("action");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can manage S3-compatible storage." }, { status: 403 });

    const bucket = url.searchParams.get("bucket");
    const key = url.searchParams.get("key");

    if (action === "buckets") {
      const buckets = await store.listS3Buckets(orgId);
      const withVersioning = await Promise.all(buckets.map(async (b) => ({ ...b, ...(await store.getBucketVersioning({ orgId, bucket: b.name })) })));
      return NextResponse.json({ buckets: withVersioning });
    }
    if (action === "objects") {
      if (!bucket) return NextResponse.json({ error: "bucket is required." }, { status: 400 });
      const result = await store.listS3Objects({ orgId, bucket, maxKeys: 1000 });
      if (!result) return NextResponse.json({ error: "NoSuchBucket" }, { status: 404 });
      return NextResponse.json(result);
    }
    if (action === "versions") {
      if (!bucket || !key) return NextResponse.json({ error: "bucket and key are required." }, { status: 400 });
      const versions = await store.listObjectVersions({ orgId, bucket, key });
      return NextResponse.json({ versions });
    }
    if (action === "health") {
      if (!bucket || !key) return NextResponse.json({ error: "bucket and key are required." }, { status: 400 });
      const health = await store.getS3ObjectHealth({ orgId, bucket, key, versionId: url.searchParams.get("versionId") || undefined });
      return NextResponse.json({ health });
    }
    if (action === "lifecycle") {
      if (!bucket) return NextResponse.json({ error: "bucket is required." }, { status: 400 });
      const policy = await store.getLifecyclePolicy({ orgId, bucket });
      return NextResponse.json({ policy });
    }
    if (action === "tags") {
      if (!bucket || !key) return NextResponse.json({ error: "bucket and key are required." }, { status: 400 });
      const result = await store.getObjectTagging({ orgId, bucket, key, versionId: url.searchParams.get("versionId") });
      return NextResponse.json(result);
    }
    if (action === "inventory") {
      const inventory = await buildStorageInventory({ orgId, bucket });
      if (url.searchParams.get("format") === "csv") {
        return new Response(renderInventoryCsv(inventory), { status: 200, headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="inaya-s3-inventory-${orgId}.csv"` } });
      }
      return NextResponse.json(inventory);
    }
    if (action === "analytics") {
      const analytics = await computeS3BucketAnalytics({ orgId, bucket });
      return NextResponse.json(analytics);
    }
    if (action === "policy-analysis") {
      const analysis = await analyzeS3CredentialPolicies({ type: "org", orgId });
      return NextResponse.json(analysis);
    }
    return NextResponse.json({ error: "Unrecognized action." }, { status: 400 });
  } catch (err) {
    console.error("orgs/s3-compat/manage GET failed:", err);
    return NextResponse.json({ error: err.message || "An internal error occurred." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, action, bucket, key, versionId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can manage S3-compatible storage." }, { status: 403 });
    const actorEmail = auth.session.email;

    if (action === "versioning") {
      const result = await store.putBucketVersioning({ orgId, bucket, status: body.status });
      return NextResponse.json(result);
    }
    if (action === "object-lock") {
      const result = await store.enableBucketObjectLock({ orgId, bucket });
      return NextResponse.json(result);
    }
    if (action === "retention") {
      const result = await store.putObjectRetention({ orgId, bucket, key, versionId, retentionMode: body.retentionMode, retentionUntil: body.retentionUntil, actorEmail });
      return NextResponse.json(result);
    }
    if (action === "legal-hold") {
      const result = await store.putObjectLegalHold({ orgId, bucket, key, versionId, legalHold: !!body.legalHold, actorEmail });
      return NextResponse.json(result);
    }
    if (action === "restore") {
      const result = await store.restoreObjectVersion({ orgId, bucket, key, versionId, actorEmail });
      return NextResponse.json({ restored: true, newVersionId: result.versionId });
    }
    if (action === "lifecycle") {
      const result = await store.putLifecyclePolicy({ orgId, bucket, rules: body.rules, actorEmail });
      return NextResponse.json(result);
    }
    if (action === "lifecycle-delete") {
      const result = await store.deleteLifecyclePolicy({ orgId, bucket, actorEmail });
      return NextResponse.json(result);
    }
    if (action === "lifecycle-run") {
      const result = await store.runLifecycleEnforcement({});
      return NextResponse.json(result);
    }
    if (action === "tags") {
      const result = await store.putObjectTagging({ orgId, bucket, key, versionId, tags: body.tags, actorEmail });
      return NextResponse.json(result);
    }
    if (action === "batch") {
      const result = await runBatchOperation({ orgId, bucket, keys: body.keys, operation: body.operation, params: body.params, actorEmail });
      return NextResponse.json(result);
    }
    return NextResponse.json({ error: "Unrecognized action." }, { status: 400 });
  } catch (err) {
    if (err?.reason === "LegalHold" || err?.reason === "ObjectLocked") return NextResponse.json({ error: err.message }, { status: 409 });
    console.error("orgs/s3-compat/manage POST failed:", err);
    return NextResponse.json({ error: err.message || "An internal error occurred." }, { status: 500 });
  }
}
