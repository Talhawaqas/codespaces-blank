# Sovereign Infrastructure Fabric — Phase 0 capability audit

Scope: the "Spinifex-Inspired Sovereign Infrastructure Fabric" SOW (`INAYA_Spinifex_Sovereign_Infrastructure_ClaudeCode_SOW.md`, 350 numbered sections, v1.0 October 2026). Written against the repository state at the commit that contains this file, per §297's requirement to inspect every named existing system before writing any new code.

**How to read this.** This is the §297 Phase-0 audit, done by direct inspection of the files named in the SOW's §6 (not assumed from the SOW's own claims). Every row below is REUSE (use the existing function/file as-is), EXTEND (add to it), or NEW (nothing comparable exists — confirmed by search, not assumption), per the SOW's own §5.1 classification requirement.

## 1. Storage control plane — REUSE/EXTEND

`src/lib/s3-compat/*`, `src/lib/storageResources.js`, `src/lib/storageSnapshots.js`, `src/lib/storageBackupPolicies.js`, `src/lib/cloudBackupScheduler.js`, `src/lib/backupEngine.js` all exist exactly as the SOW assumed.

`storageResources.js` contains the physical-capability marker the SOW quoted, verbatim:

```js
const PHYSICAL_CAPABILITY = {
  volume: "logical_only_no_compute_attach", // no VM/hypervisor runtime exists in Inaya to attach a real block device to
  fileShare: "logical_only_no_nfs_server",  // no multi-client NFS protocol server exists
};
```

and an explicit honesty-boundary comment: *"The audit confirmed Inaya has NO compute/VM/hypervisor runtime of any kind... Building a real attachable block device... would mean either fabricating a fake compute layer or lying about physical capability — both explicitly forbidden by this SOW."* This is the exact gap this SOW closes. `storageResources.js` itself is not touched by this SOW — the new physical block provider (Phase 3) sits *underneath* it; `storageSnapshots.js` is EXTENDed so a physical snapshot can reference an existing logical storage-resource identity (§27), never duplicated.

Exports confirmed: `RESOURCE_TYPES`, `createStorageResource`, `listStorageResources`, `getStorageResource`, `expandStorageResourceCapacity`, `deleteStorageResource`, `attachVolume`, `detachVolume`, permission-checked inline via `canManageStorage`/`canAccessStorage` from `orgGates.js`.

## 2. Managed database — REUSE

`src/lib/rds/` (`db.js`, `instances.js`, `providerRegistry.js`, `record.js`, `providers/`). `instances.js` exports `provisionInstance`, `listInstances`, `getInstanceStatus`, `stopInstance`/`startInstance`, `deprovisionInstance`, `listSnapshots`, `restorePointInTime`, `runQuery`. Routes at `src/app/api/orgs/rds/instances/**`. Not touched by this SOW; `providerRegistry.js` + `providers/supabase.js` is the house precedent for a *real external-provider-backed* resource — the template this SOW's `COMPUTE_INSTANCE`/`VPC` resources follow (genuinely backed by the new Rust runtime, not a declared-only record like `storageResources.js`'s volumes).

## 3. Identity — REUSE

`src/lib/orgGates.js`, `src/lib/identity/` (`entraGraph.js`, `scim.js`, `mapping.js`, `reconcile.js`, `provisioning engine.js`, `outbound.js`, `revocation.js`, `grants.js`, `msp.js`). AD/LDAP sync is the sibling package `ad-sync-agent/`. API-key infra is `src/lib/api-keys.js` (`createApiKey`, `revokeApiKey`, `listApiKeys`, `requireApiKey`). Not touched; infra org routes/public-API routes consume `requireApiKey`/`requireMembership` exactly as every other domain does.

## 4. Authorization — EXTEND (minimally, done)

`requireMembership(req, orgId, { requireManage })` — `src/lib/orgs.js:1018`. `getAccessibleScope()` — `src/lib/document-permissions.js:172`. The `canManageX`/`canAccessX` pairs live in `src/lib/orgGates.js`, re-exported wholesale by `orgs.js`.

**Done in this phase**: added `canManageInfrastructure`/`canAccessInfrastructure` to `orgGates.js`, gated by an optional `infrastructureRole` field on `org_members` (`"manager"`/`"staff"`), following the exact `storageRole`/`dataSourceRole`/`nasRole` precedent — no restructure of the primary `role` field, no new permission-string registry (confirmed none exists elsewhere in this codebase). Re-exported from `orgs.js`. Finer-grained `canAccessCompute`/`canAccessNetwork`/`canAccessCluster` (§67's other candidates) are deferred until a real need for sub-scoping within the Infrastructure console appears — §67 calls these "candidate" gates, not mandatory, and the existing precedent (one role field per domain, e.g. `storageRole` covers all of storage) argues against manufacturing finer splits that nothing yet needs.

## 5. Trust and evidence — EXTEND

`src/lib/auditChain.js` (`appendAuditEntry`, `verifyChainIntegrity`), `src/lib/org-activity-log.js` (`logOrgActivity`) — `recordType` is a genuinely free string, no enum, no validation. New infra record types (`COMPUTE_INSTANCE`, `VOLUME`, `VPC`, ...) need zero registry changes here.

`src/lib/businessEvents.js` is different: `EVENT_TYPES` and `SUBJECT_RESOLVERS` **are** a closed, validated registry (`resolveSubject()` returns a 400 for an unregistered `subjectType`). Each new Evidence Graph subject needs one `EVENT_TYPES` entry, one `SUBJECT_RESOLVERS` entry pointing at a real collection, and a `summarizeSubject()` case. `createBusinessEvent()` only ever stores a small `{subjectType, subjectId, subjectSummary}` reference, confirmed by both code and its own header comment — never a shadow copy.

`src/lib/evidenceExporter.js`, `src/lib/businessEventPassport.js` are generic over `subjectType` once registered — no code changes needed beyond the registration above.

## 6. Resilience — EXTEND

`src/lib/resilience-policy.js`, `resilience-canary.js`, `resilience-orchestrator.js`, `resilience-status.js` (flat under `src/lib/`, not a subfolder, contrary to the SOW's assumed path shape — confirmed by direct listing). Infra-specific recovery adapters (`COMPUTE_RECOVERY`, `VOLUME_RECOVERY`, `NETWORK_RECOVERY`, `NODE_FAILURE`, `CLUSTER_RECOVERY`) extend `resilience-orchestrator.js`'s existing test-type registry in Phase 6/7, never a second engine.

## 7. AI — EXTEND

`src/lib/aiSecurity/` (`gateway.js`, `routeGuard.js`, `policyEngine.js`, ...). `src/lib/ai-action-requests.js` is the controlled-execution pipeline: `AI_ACTION_STATUSES = ["PENDING_APPROVAL","APPROVED","REJECTED","QUEUED","EXECUTED","EXPIRED","CANCELLED"]`, `proposeAiAction()`, `reviewAiAction()`, `executeApprovedAiActions()` (cron executor, the **only** path that calls a real mutation, via an `EXECUTORS` map keyed by `targetRecordType`). `src/lib/ai-os-router.js` is the thin per-domain dispatch shim (`buildOsContext`, `getOsToolDeclarations`, `runOsTool`, `osSystemInstruction`). Infra AI tools (read-only in Phase 7, per §111) register the same way `ai-security-tools.js` does — no new engine, no direct-execution bypass permitted for destructive actions (§112).

## 8. Terraform provider — EXTEND

`terraform-provider-inaya/` is inside this repo (not a sibling), Go, HashiCorp `terraform-plugin-framework`. `resource_storage_resource.go` is the exact CRUD template (`Metadata()`/`Create()`/`Read()`/`Update()`/`Delete()`/`ImportState()`) new resources (`inaya_compute_instance`, `inaya_vpc`, `inaya_subnet`, `inaya_security_group`, ...) follow in Phase 8.

## 9. Desktop — EXTEND (deferred to a later pass)

`inaya-desktop` is a sibling Tauri app (Rust + JS). `DirectSync` (`src-tauri/src/directsync.rs`) is its own Rust S3 client/signer — confirmed it does **not** literally share the Node `s3-compat/sigv4.js` code (different language/runtime), so "shares a common signer architecture" means the same protocol, not shared source. Per §129 ("do not turn the Drive helper into a hypervisor service"), infrastructure management stays a separate capability from DirectSync; desktop UI work for Infrastructure is deferred past this pass's Phase 10 (web console first).

## 10. `trustHealth.js` — EXTEND (Phase 7)

`src/lib/trustHealth.js` combines audit-chain integrity, AI-action backlog, business insights, security stats, backup health, document-automation health into one `{scope, computedAt, overallStatus, ...}` shape. Infra health becomes one more input, not a second dashboard (§80).

## 11. Digital Twin — EXTEND (Phase 7)

`src/lib/digitalTwin.js` (`resolveDependents`, `traverseDependencyGraph`). Storage resources are deliberately excluded from the generic dependency table and handled in a dedicated branch that checks `storageRole` rather than defaulting to visible-if-no-departmentId — this is the exact precedent for infrastructure resources (org-wide, gated by `infrastructureRole`, not department membership).

## 12. Notifications — EXTEND (Phase 7)

`src/lib/notify/router.js` (`EVENTS` catalog, `notifyEvent()`, `CHANNELS`). New events (`node_down`, `node_degraded`, `capacity_low`, `volume_failed`, `cluster_partition`, `certificate_expiring`, `security_group_changed`, `recovery_failed`) are catalog entries, not a new delivery system.

## 13. Workflow Manager — EXTEND (future pass)

`src/lib/workflows/` (`engine.js`, `nodes.js`, `runner.js`, `catalog.js`, ...). New node types (`check_cluster`, `check_capacity`, `check_instance`, `create_incident`, `request_approval`) register in the existing catalog; no second engine.

## 14. Documentation platform — NEW content, EXISTING loader

`src/lib/docsContent.js` (`loadAllDocs`, `getDocBySlug`, ...). `content/docs/infrastructure/` does not exist yet — confirmed by directory listing. Phase 0 creates it.

## 15. AI Security gateway route-wiring test — REUSE (future pass, when an infra AI route is added)

`test/ai-security-wiring.test.mjs` scans `src/app/api/ai/*/route.js` for any route calling a model SDK and asserts it also calls `checkInputSecurity`/`guardAiInput`. Any future infra AI chat route must follow this pattern and be added to the test's expected `wired` array — not relevant until Phase 7's read-only AI tools graduate to a chat surface, if ever.

## 16. Org API route convention — REUSE

`src/app/api/orgs/pqc/devices/_lib.js` and `.../endpoint-backup/_lib.js` share an identical skeleton: `ensureOrgIndexes()` → `requireMembership(req, orgId)` → `requireFeature("FEATURE_X", orgId)` → thin handler → uniform `json()` envelope → domain `Error` subclass → generic 500 fallback. Phase 1+ infra routes under `src/app/api/orgs/infrastructure/*` follow this exact shape with `FEATURE_INFRASTRUCTURE` and a new `InfrastructureError` class.

## 17. Public API convention — REUSE

`src/lib/api-keys.js:requireApiKey(req)` derives `orgId` only from the stored key record, never from the request body — confirmed, matches §68 exactly already. Representative route: `src/app/api/public/v1/evidence/route.js`.

## 18. Async operation pattern — REUSE

`src/lib/jobs/run.js:withJobRun({ name, orgId, fn })` → `{status: "running"|"succeeded"|"failed"|"skipped"|"stale", runId, ...}`, tenant-scoped leases, retry/backoff, stale-run self-healing. This is the `operationId`/status primitive §71 asks for — `runId` becomes the infra `operationId`; no parallel job table.

## 19. OpenAPI generation — EXTEND

`scripts/docs/generate-openapi.mjs` reads `src/lib/docsApiReference.js`'s `API_ENDPOINTS`/`API_AUTH_NOTE` and writes `public/openapi.json`. New infra endpoints are entries in `API_ENDPOINTS`, not a second generator.

## 20. MongoDB collection convention — REUSE (newer pattern)

Two conventions coexist: the centralized `orgs.js:ensureOrgIndexes()` monolith (older/majority), and a module-local lazy `col()` pattern (`src/lib/pqc/deviceKeys.js`) — self-contained, memoized-on-first-call index creation, no edit to the shared monolith. New `infra_clusters`/`infra_nodes`/`compute_instances`/`infra_volumes`/`infra_vpcs`/`infra_subnets`/`infra_security_groups` collections follow the `pqc/deviceKeys.js` pattern.

## 21. Prior art for compute/VM/VPC/hypervisor concepts — NONE (confirmed greenfield)

Grepped `qemu|kvm|nats|ovn|hypervisor` case-insensitive across `inaya-network-dapp`, `custody-sdk`, `inaya-migration-agent`, `inaya-desktop`: zero code matches (two incidental marketing-prose matches in roadmap content files, not code). This is genuinely new ground — nothing to accidentally duplicate.

## 22. Security Layer — EXTEND (`incidents.js`, not `security.js`)

`src/lib/security.js`'s `recordSecurityEvent`/`recordSecurityReport` use a fixed category enum (`SECURITY_CATEGORIES`) that mirrors `InayaThreatRegistry.sol`'s on-chain `uint8` layout 1:1 — **not** extended for infra signals, since that would require an on-chain enum change for an unrelated domain. `src/lib/incidents.js:createIncident()` (category `"infrastructure_security"` added to its existing `INCIDENT_CATEGORIES` array) is the correct generic fit — real state machine, real notification routing, no new system.

## Summary

Every system the SOW's §6 names for reuse exists at the path the SOW assumed, confirmed by direct inspection rather than taken on faith. Two deliberate deviations from the SOW's literal section numbering, both justified above: (a) Evidence Graph `subjectType` is a closed registry, not the free-form field §81 implies — extending it is one line per subject, not a design problem; (b) `security.js`'s event categories are on-chain-synced and must not be touched — `incidents.js` is the right home for infra security signals instead. Nothing else required deviating from the SOW's own reuse map.
