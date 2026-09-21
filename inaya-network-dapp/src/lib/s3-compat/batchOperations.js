// src/lib/s3-compat/batchOperations.js
//
// AWS S3 Feature Expansion SOW, Phase 3 -- Batch Operations. Per the
// SOW's own required architecture ("no direct low-level database
// mutation from the batch UI"), this is strictly an orchestration loop
// over the EXISTING per-object primitives (putObjectTagging,
// putObjectRetention, putObjectLegalHold) -- it contains no Mongo query
// of its own. A locked/held object's real rejection (ObjectProtectedError)
// surfaces as a normal per-object failure, never a job-crashing exception
// -- Object Lock/Legal Hold are enforced exactly as strictly in a batch
// job as in a single manual request, per the SOW's explicit "no bypass of
// Object Lock/legal hold" requirement.

import { putObjectTagging, putObjectRetention, putObjectLegalHold } from "./store.js";

const OPERATIONS = {
  SET_TAGS: (ctx, key) => putObjectTagging({ orgId: ctx.orgId, bucket: ctx.bucket, key, tags: ctx.params.tags, actorEmail: ctx.actorEmail }),
  SET_RETENTION: (ctx, key) => putObjectRetention({ orgId: ctx.orgId, bucket: ctx.bucket, key, retentionMode: ctx.params.retentionMode, retentionUntil: ctx.params.retentionUntil, actorEmail: ctx.actorEmail }),
  SET_LEGAL_HOLD: (ctx, key) => putObjectLegalHold({ orgId: ctx.orgId, bucket: ctx.bucket, key, legalHold: !!ctx.params.legalHold, actorEmail: ctx.actorEmail }),
};

/** Runs one operation across a bounded list of keys, returning a per-key
 *  result so a partial failure is always visible and named -- never a
 *  silent drop, and never an all-or-nothing job that fails 999 good keys
 *  because of 1 bad one. */
export async function runBatchOperation({ orgId, bucket, keys, operation, params, actorEmail }) {
  const handler = OPERATIONS[operation];
  if (!handler) throw new Error(`Unknown batch operation "${operation}". Must be one of ${Object.keys(OPERATIONS).join(", ")}.`);
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("keys must be a non-empty array.");
  if (keys.length > 1000) throw new Error("A batch job is limited to 1000 keys per request.");

  const ctx = { orgId, bucket, params: params || {}, actorEmail };
  const results = [];
  for (const key of keys) {
    try {
      const result = await handler(ctx, key);
      results.push({ key, status: "SUCCEEDED", result });
    } catch (err) {
      results.push({ key, status: "FAILED", error: err.message, reason: err.reason || null });
    }
  }

  return {
    operation,
    bucket,
    totalKeys: keys.length,
    succeeded: results.filter((r) => r.status === "SUCCEEDED").length,
    failed: results.filter((r) => r.status === "FAILED").length,
    results,
  };
}
