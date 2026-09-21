// src/lib/docsApiReference.js
//
// Official Documentation Platform SOW -- hand-authored from the Phase 0
// audit of src/app/api/public/v1/**/route.js (the only route namespace
// designed for third-party integration; see docs/audit/documentation-
// inventory.md for why the other ~509 internal routes aren't documented
// here). No OpenAPI spec exists in this repo to generate from, so this is
// the authoritative source until one exists -- every field below was
// verified against the actual route file, not invented.

export const API_AUTH_NOTE =
  "Every public/v1 request needs Authorization: Bearer <api key>. An org owner/admin issues a key from the Business Workspace's API Keys settings (src/app/api/orgs/api-keys/route.js), or Terraform can be pointed at one via INAYA_API_KEY. The key resolves to exactly one organization server-side (requireApiKey() in src/lib/api-keys.js) -- no request body or query parameter can ever point it at a different org.";

export const API_ENDPOINTS = [
  {
    slug: "evidence",
    method: "GET",
    path: "/api/public/v1/evidence",
    summary: "Fetch the evidence trail for one business record.",
    params: [
      { name: "recordType", in: "query", required: true, description: "The record's type, e.g. INVOICE, PURCHASE_ORDER." },
      { name: "recordId", in: "query", required: true, description: "The record's id." },
    ],
    response: "The record's evidence trail (getEvidenceTrail()) -- the same tamper-evident audit chain data the Business Workspace's own Audit Trail view reads.",
    status: "live",
  },
  {
    slug: "audit-verify",
    method: "GET",
    path: "/api/public/v1/audit/verify",
    summary: "Verify the calling organization's full audit-chain integrity.",
    params: [],
    response: "A pass/fail integrity result over the org's entire audit chain (verifyOrgEvidenceIntegrity()).",
    status: "live",
  },
  {
    slug: "permissions-check",
    method: "GET",
    path: "/api/public/v1/permissions/check",
    summary: "Check whether a named permission gate is enabled for the calling organization.",
    params: [
      { name: "gate", in: "query", required: true, description: "One of 17 gate names, e.g. canManageFinance, canAccessAudit, canManageGovernment -- see orgGates.js for the full list." },
    ],
    response: "{ gate, allowed }. Note: an API key always resolves a synthetic owner-level membership, so this checks that a capability exists and is enabled for the org, not a specific human's individual role.",
    status: "live",
  },
  {
    slug: "storage-resources-list-create",
    method: "GET, POST",
    path: "/api/public/v1/storage/resources",
    summary: "List or create storage resources (volumes / file shares).",
    params: [
      { name: "type", in: "query (GET)", required: false, description: '"volume" or "fileShare".' },
      { name: "tag.<key>", in: "query (GET)", required: false, description: "Any number of tag.<key>=<value> params filter by tag." },
      { name: "type, name, region, capacity, performanceProfile, tags", in: "body (POST)", required: "type, name required", description: "Creates a resource -- see the Storage Control Plane product guide for the full field meanings." },
    ],
    response: "GET: { resources: [...] }. POST: { resource: {...} }.",
    status: "live",
  },
  {
    slug: "storage-resource-detail",
    method: "GET, PATCH, DELETE",
    path: "/api/public/v1/storage/resources/{resourceId}",
    summary: "Read, expand the capacity of, or delete one storage resource.",
    params: [
      { name: "action, newCapacityGB", in: "body (PATCH)", required: true, description: 'action must be "expand"; capacity is increase-only, a decrease is rejected with a 400.' },
    ],
    response: "GET: { resource }. PATCH: { requestedGB }. DELETE: { deleted: true }.",
    status: "live",
  },
  {
    slug: "snapshots-list-create",
    method: "GET, POST",
    path: "/api/public/v1/storage/snapshots",
    summary: "List or create point-in-time snapshots of a storage resource.",
    params: [
      { name: "resourceId", in: "query (GET) or body (POST)", required: "for POST", description: "The source inaya_storage_resource id." },
    ],
    response: "GET: { snapshots: [...] }. POST: { snapshot: {...} } -- a real, incremental, independently-verifiable capture; see the Storage Control Plane guide.",
    status: "live",
  },
  {
    slug: "snapshot-detail",
    method: "GET, DELETE",
    path: "/api/public/v1/storage/snapshots/{snapshotId}",
    summary: "Read or delete one snapshot.",
    params: [],
    response: "GET: { snapshot }. DELETE: { deleted: true }.",
    status: "live",
  },
  {
    slug: "backup-policies-list-create",
    method: "GET, POST",
    path: "/api/public/v1/storage/backup-policies",
    summary: "List or create a tag-selector-scoped automated backup policy.",
    params: [
      { name: "name, tagSelector, notificationPolicy", in: "body (POST)", required: "name required", description: 'tagSelector is a {key: value} map; notificationPolicy is "onFailure" (default), "always", or "never".' },
    ],
    response: "GET: { policies: [...] }. POST: { policy: {...} }.",
    status: "live",
  },
  {
    slug: "backup-policy-detail",
    method: "GET, PATCH, DELETE",
    path: "/api/public/v1/storage/backup-policies/{policyId}",
    summary: "Read, pause/resume, or delete one backup policy.",
    params: [
      { name: "enabled", in: "body (PATCH)", required: true, description: "true to resume, false to pause." },
    ],
    response: "GET: { policy }. PATCH: { policy }. DELETE: { deleted: true } (soft delete).",
    status: "live",
  },
  {
    slug: "backup-plans-list-create",
    method: "GET, POST",
    path: "/api/public/v1/storage/backup-plans",
    summary: "List or create a schedule + retention rule under a backup policy.",
    params: [
      { name: "policyId", in: "query (GET)", required: false, description: "Filter to one policy's plans." },
      { name: "policyId, frequency, retentionCount, priority", in: "body (POST)", required: "policyId, frequency, retentionCount required", description: 'frequency is one of daily/weekly/monthly/longTerm.' },
    ],
    response: "GET: { plans: [...] } (each with a computed health field). POST: { plan: {...} }.",
    status: "live",
  },
  {
    slug: "backup-plan-detail",
    method: "GET, DELETE",
    path: "/api/public/v1/storage/backup-plans/{planId}",
    summary: "Read or delete one backup plan.",
    params: [],
    response: "GET: { plan } (with health). DELETE: { deleted: true } (soft delete).",
    status: "live",
  },
];
