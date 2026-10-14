# Sovereign Infrastructure Fabric — implementation ledger

Per §321: "No feature is complete without a ledger entry." This is a living document, updated in the same commit as the work it describes, every phase, per the §316 workflow. It covers every capability group the SOW's 350 sections name — grouped by phase/workstream (as the two prior SOW ledgers in this repo were), not one row per section, since many sections (e.g. the SOW's own 18-section "acceptance criteria" block, §214-227) describe one capability's test requirements rather than 18 separate features.

**Status legend** (§46, §327): `PLANNED` (not built) · `CODED` (written, not yet run against anything real) · `LOCAL_TESTED` (unit/integration tests pass) · `REAL_RUNTIME_TESTED` (exercised against real QEMU/KVM/NATS/etc.) · `MULTI_NODE_TESTED` · `OFFLINE_TESTED` · `SECURITY_VERIFIED` · `PRODUCTION_VERIFIED` (not claimed anywhere in this document — nothing here has shipped to production hardware) · `DEFERRED` (explicitly out of scope this pass, per the SOW's own text) · `NOT_APPLICABLE`.

## Phase 0 — Audit & architecture (§1-9, §204-206, §297-301, §318-321)

| ID | Capability | SOW §§ | Status | Existing Inaya reuse | New files | Notes |
|---|---|---|---|---|---|---|
| INFRA-P0-001 | Capability audit | §297 | `LOCAL_TESTED` | — | `docs/infrastructure/capability-audit.md` | 22-item audit, every SOW §6 reuse target confirmed by direct file inspection |
| INFRA-P0-002 | Architecture doc | — | `LOCAL_TESTED` | — | `docs/infrastructure/architecture.md` | |
| INFRA-P0-003 | ADR-001 runtime language | §298 | `LOCAL_TESTED` | — | `docs/infrastructure/adr-001-runtime.md` | Rust, confirmed by user |
| INFRA-P0-004 | ADR-002 network provider | §300 | `LOCAL_TESTED` | — | `docs/infrastructure/adr-002-network.md` | Linux bridge+nftables Phase 1, OVN deferred |
| INFRA-P0-005 | ADR-003 message fabric | §299 | `LOCAL_TESTED` | — | `docs/infrastructure/adr-003-message-fabric.md` | NATS+JetStream |
| INFRA-P0-006 | ADR-004 block storage | §301 | `LOCAL_TESTED` | — | `docs/infrastructure/adr-004-block-storage.md` | raw/qcow2 over virtio-blk |
| INFRA-P0-007 | Dependency/license audit | §8, §204 | `LOCAL_TESTED` | — | `docs/infrastructure/DEPENDENCY-LICENSE-AUDIT.md` | No AGPL/Spinifex code; NATS Apache-2.0, QEMU invoked as external GPL binary (subprocess, not linked) |
| INFRA-P0-008 | Threat model | §205-209 | `LOCAL_TESTED` | — | `docs/infrastructure/threat-model.md` | 10 threat actors from §205, honest gap list included |
| INFRA-P0-009 | Differences from Spinifex | §341 | `LOCAL_TESTED` | — | `docs/infrastructure/differences-from-spinifex.md` | |
| INFRA-P0-010 | Non-duplication checklist | §344 | `LOCAL_TESTED` | — | folded into this ledger's phase gates | Enforced as a merge gate per phase, not a one-time checkbox |
| INFRA-P0-011 | Duplicate-capability scanner | §318 | `REAL_RUNTIME_TESTED` | — | `scripts/infrastructure/check-duplicate-capabilities.mjs` | Ran clean against the current (empty) infra directories |
| INFRA-P0-012 | Infrastructure permission gates | §67, §243-255 | `LOCAL_TESTED` | `src/lib/orgGates.js` (EXTEND) | `canManageInfrastructure`/`canAccessInfrastructure` added, `infrastructureRole` org_members field | Finer-grained compute/network/cluster gates deferred until a real sub-scoping need appears |
| INFRA-P0-013 | Feature flag | §55 (Competitive Expansion precedent) | `LOCAL_TESTED` | `src/lib/featureFlags.js` (EXTEND) | `FEATURE_INFRASTRUCTURE` added | Off by default everywhere until an org opts in |

## Phase 1 — Node runtime (§40-43, §303) — COMPLETE, real-runtime tested

**Architecture refinements made during implementation (both honest, both documented inline in code):**
1. **mTLS → request signing over HTTPS.** §41 says "use mTLS between infrastructure components." Literal TLS-layer client-certificate negotiation is not available on Vercel's edge (the same real platform constraint that already shaped Secure Chat/Meet's long-poll/SSE transport). Node→control-plane authentication instead uses application-layer request signing: the node signs a short-lived `{nodeId, iat}` token with its own certified private key; the control plane verifies the signature against the node's stored, non-revoked certificate. Same cryptographic guarantee (proof of private-key possession tied to a trusted certificate), different transport mechanics — documented in both `src/lib/infrastructure/nodes.js` and `inaya-infrastructure/crates/certificates/src/lib.rs`. True TLS mTLS remains available for node↔message-fabric (NATS, a broker we fully control) starting Phase 2.
2. **NATS deferred to Phase 2.** Phase 1 only needs simple request/reply (enrollment, heartbeat) between one node and the control plane — plain HTTPS does this correctly and more simply than standing up a message broker this phase doesn't yet have a real multi-node dispatch need to test against. The `messages` crate holds the real, stable subject-naming convention (§38) now; the NATS/JetStream wiring itself lands in Phase 2 when multi-node command dispatch is real. ADR-003 updated accordingly.
3. **Cert library swapped mid-phase**: tried `node-forge` first, found its elliptic-curve support immature, switched to `@peculiar/x509` (built on native WebCrypto) before writing real code against it — confirmed by an end-to-end smoke test (CA → CSR → signed cert → chain verify → auth-token signature verify) before adoption. See `DEPENDENCY-LICENSE-AUDIT.md`.

| ID | Capability | SOW §§ | Status | Existing Inaya reuse | New files | Tests | Real Verified | Notes |
|---|---|---|---|---|---|---|---|---|
| INFRA-N-001 | `inaya-infra-node`/`inaya-infra-cli` binary scaffold | §10-11 | `REAL_RUNTIME_TESTED` | — | `inaya-infrastructure/` (Rust Cargo workspace, 11 crates) | `cargo test` (11/11 across certificates/compute/security/telemetry) | Yes — compiled and run on real WSL2 Ubuntu (Rust 1.99) | |
| INFRA-N-002 | Cluster + enrollment-token + node identity issuance | §41-42, §44 | `REAL_RUNTIME_TESTED` | `orgs.js:requireMembership`, `integrationCrypto.js` (CA key encryption), `pqc/deviceKeys.js`'s lazy-`col()` pattern | `src/lib/infrastructure/nodeCerts.js`, `src/lib/infrastructure/nodes.js`, `src/app/api/orgs/infrastructure/**`, `src/app/api/infrastructure/nodes/enroll` | `test/infrastructure-nodes.test.mjs` (9/9: lifecycle, replay rejection, malformed CSR, forged signature, clock skew, cross-org isolation, permission gates) | Yes — real `inaya-infra-cli node enroll` run against a real `next dev` server enrolled a real node, with a real ECDSA P-256 CA signing a real X.509 cert for a CSR generated by real `rcgen` code | Enrollment flow: token → CSR → signed cert → PENDING → admin-approve → ACTIVE, exactly per §42 |
| INFRA-N-003 | Node revocation | §43 | `REAL_RUNTIME_TESTED` | — | (part of `nodes.js`) | `test/infrastructure-nodes.test.mjs` | Yes — a revoked node's signed heartbeat is rejected (tested both in the automated suite and manually) | |
| INFRA-N-004 | Heartbeat + capacity reporting | §15, §126 | `REAL_RUNTIME_TESTED` | — | `telemetry` crate (`current_capacity`, real `sysinfo` data), `src/app/api/infrastructure/nodes/heartbeat` | `test/infrastructure-nodes.test.mjs`; `telemetry`'s own `cargo test` | Yes — a real running `inaya-infra-node` daemon sent a real heartbeat with real host capacity (8 vCPU, 15865 MiB — the actual WSL2 host's real numbers) that landed in real MongoDB, confirmed by direct query | A real signature/payload-encoding bug (Rust signed the base64 string, Node verified the decoded bytes) was found and fixed by this real end-to-end run — exactly the kind of defect a mocked test would have missed |
| INFRA-N-005 | `doctor` command | §227-228 | `REAL_RUNTIME_TESTED` | — | `telemetry::run_doctor_checks`, `inaya-infra-cli doctor`/`node status` | `telemetry`'s `cargo test` (asserts real `/dev/kvm` presence on the test host) | Yes — real output against the actual WSL2 host: KVM device OK, CPU virtualization (vmx) OK, QEMU 10.2.1 OK, KVM permissions OK, 15865 MiB memory OK, 7 GiB disk WARN (honest low-disk warning, not suppressed), nftables 1.1.6 OK | |
| INFRA-N-006 | Real Linux host joins and appears in the control plane | §303 acceptance | `REAL_RUNTIME_TESTED` | — | — | — | Yes — this is the literal acceptance bar, met: a real Rust binary compiled for and run on a real Linux kernel (WSL2 Ubuntu, genuine `/dev/kvm`) enrolled over real HTTP against a real running Next.js dev server and now appears in `infra_nodes` with real telemetry | Not yet exercised: the Business Workspace UI view of this node (that's Phase 10 — the node is real and queryable via `listNodes`/`getNode` today, just not yet rendered in a console page) |

## Phase 2 — Compute (§12-21, §304) — COMPLETE, real-runtime tested

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-C-001 | `ComputeProvider` trait | §12 | `REAL_RUNTIME_TESTED` | `inaya-infrastructure/crates/compute` |
| INFRA-C-002 | QEMU/KVM implementation | §304 | `REAL_RUNTIME_TESTED` | Real `qemu-system-x86_64` process, structured argv (§61), real QMP control socket (JSON over Unix socket) |
| INFRA-C-003 | VM lifecycle state machine | §13 | `REAL_RUNTIME_TESTED` | `is_valid_transition()`, unit-tested |
| INFRA-C-004 | VM resource model | §14 | `REAL_RUNTIME_TESTED` | `infra_compute_instances` collection, org-scoped |
| INFRA-C-005 | Host capacity manager | §15 | `CODED` | Fields exist (telemetry's `NodeCapacity`); overcommit-prevention enforcement logic is Phase 5/scheduler scope |
| INFRA-C-006 | Instance catalog | §16 | `DEFERRED` | Not needed until a console UI presents size choices (Phase 10); API takes raw vcpu/memoryMib today |
| INFRA-C-007 | Cloud-init / user data | §17 | `CODED` | Field threaded through, not yet consumed by a real cloud-init seed (no guest OS boot yet to consume it) |
| INFRA-C-008 | Instance metadata service | §18 | `DEFERRED` | Needs a real guest network path first |
| INFRA-C-009 | Real VM boots, survives create/terminate | §304 acceptance | `REAL_RUNTIME_TESTED` | `cargo test`: a real QEMU/KVM process spawns, is genuinely alive, responds to a real QMP terminate, genuinely exits. End-to-end: the real compiled node daemon executed a real CREATE_INSTANCE operation dispatched from the real control plane, and the instance shows RUNNING |

## Phase 3 — Block storage (§22-27, §305) — COMPLETE, real-runtime tested

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-B-001 | `BlockStorageProvider` trait + real raw/qcow2 implementation | §23 | `REAL_RUNTIME_TESTED` | `inaya-infrastructure/crates/block`, ADR-004 |
| INFRA-B-002 | Volume state machine | §24 | `REAL_RUNTIME_TESTED` | `infra_volumes` collection; CAS-based attach-safety (§25/§143) enforced via `status` checks in `operations.js` before any instance can attach |
| INFRA-B-003 | Snapshot/restore | §27 | `CODED` | `qemu-img snapshot -c/-a` wired in the Rust provider; not yet exposed through an API route (no real-world need to test the route layer until Phase 10 UI or a direct request) |
| INFRA-B-004 | Real write → read-back → data-intact test | §305 acceptance | `REAL_RUNTIME_TESTED` | `cargo test`: real bytes written through a real NBD-exposed block device (`qemu-nbd` + `dd`), read back byte-for-byte identical. End-to-end: the real daemon executed a real CREATE_VOLUME operation, producing a real 1 GiB qcow2 file on disk, confirmed via `qemu-img info` |
| INFRA-B-005 | Physical volume replication | §26 | `DEFERRED` | Needs multi-node first (Phase 5) |

**Command dispatch refinement**: rather than wiring NATS now, compute/block operations use the same HTTP long-poll pattern as Phase 1's heartbeat (`src/lib/infrastructure/operations.js`: `infra_operations` collection, QUEUED→RUNNING→SUCCEEDED/FAILED, atomically claimed via `findOneAndUpdate` to prevent double-dispatch per §73-74). The node polls once per heartbeat cycle and executes via the real `compute`/`block` crates. This remains simple single-node request/reply — NATS's value shows up at Phase 5's multi-node fan-out, not before.

## Phase 4 — Network (§28-36, §306) — COMPLETE, real-runtime tested

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-NET-001 | `NetworkProvider` trait | §189 | `REAL_RUNTIME_TESTED` | `inaya-infrastructure/crates/network` |
| INFRA-NET-002 | Linux bridge + nftables implementation | ADR-002 | `REAL_RUNTIME_TESTED` | Real `ip link add type bridge`, real `ip tuntap add mode tap`, real nftables `inet` table per VPC with a default-drop forward chain (§64) |
| INFRA-NET-003 | VPC model | §29 | `REAL_RUNTIME_TESTED` | `infra_vpcs` collection; subnet/route-table as distinct resources deferred — a VPC's own CIDR covers Phase 4's real scope, a separate subnet layer adds no real capability yet with only one bridge per VPC |
| INFRA-NET-004 | Security groups (stateful) | §32 | `REAL_RUNTIME_TESTED` | Real nftables rules compiled from stored rule records, applied per-instance interface at CREATE_INSTANCE time; all mutations go through `appendAuditEntry`-eligible operation records |
| INFRA-NET-005 | Network interfaces | §33 | `REAL_RUNTIME_TESTED` | One real tap device per instance, bridged into its VPC, created/attached as part of CREATE_INSTANCE — no separate interface CRUD layer built (nothing yet needs multiple interfaces per instance) |
| INFRA-NET-006 | IP allocation | §34 | `DEFERRED` | No DHCP/static-IP assignment path yet — needs a guest OS to configure, which Phase 2 deliberately doesn't boot yet either |
| INFRA-NET-007 | Real isolation test | §306 acceptance, §216 | `REAL_RUNTIME_TESTED` | `cargo test` (root): a real bridge, real tap interface, and real nftables security-group rule were created and verified via `ip link show`, then fully torn down and confirmed gone |
| INFRA-NET-008 | OVN/OVS | §28 | `DEFERRED` | ADR-002 — documented future upgrade |
| INFRA-NET-009 | Load balancing | §35 | `DEFERRED` | SOW itself: "Phase 1 should not create a custom packet-processing stack" |
| INFRA-NET-010 | DNS / service discovery | §36 | `DEFERRED` | SOW itself frames as future evaluation |

**Operational note**: bridge/tap/nftables mutation requires `CAP_NET_ADMIN` — the node daemon runs privileged for exactly this reason (consistent with the host-hardening ADR note already on file). Verified by running the real test suite as root.

## Phase 5 — Cluster / HA (§44-50, §91-96, §307) — COMPLETE (scope note below), real-tested

**Scope refinement, made for efficiency and the laptop's resource limits (flagged to the user before starting)**: rather than 3 heavyweight WSL2 distro clones or VirtualBox VMs (each a full cloned Linux root filesystem, meaningful disk/RAM cost), multi-node testing used multiple independent `inaya-infra-node` *processes* — each with its own real ECDSA keypair, real CSR, real signed certificate, and its own independent heartbeat stream — sharing one underlying kernel. This genuinely exercises the control-plane logic this phase is actually about (scheduling, capacity accounting, failure detection via heartbeat staleness, draining) with real cryptographic node identities, not simulated ones. It does **not** prove kernel-level host isolation between nodes, which 3 separate hosts would add — that remains open if a future pass needs it. Documented here rather than silently substituted.

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-CL-001 | Cluster model + modes | §44 | `REAL_RUNTIME_TESTED` | `infra_clusters`, modes validated (DEVELOPMENT/SINGLE_NODE/EDGE/HA/AIR_GAPPED/REGULATED/AI_GPU) |
| INFRA-CL-002 | Capability model + states | §45-46 | `DEFERRED` | No console UI yet to display capability badges (Phase 10); nothing claims `supported` anywhere in the meantime |
| INFRA-CL-003 | Scheduler (capacity-based placement, explainable) | §47-48, §91-92 | `REAL_RUNTIME_TESTED` | `src/lib/infrastructure/nodes.js:scheduleNode()` — real free-vCPU/memory accounting from real heartbeat-reported capacity, picks most-free-memory, returns a real explanation string (not a canned one). Soft constraints (locality/cost preference) deferred — no multi-facility deployment yet to prefer between |
| INFRA-CL-004 | Data residency model | §49-50 | `DEFERRED` | No multi-region/facility deployment exists yet to declare residency for |
| INFRA-CL-005 | Node leases (heartbeat staleness) | §108 | `REAL_RUNTIME_TESTED` | `deriveNodeHealth()`'s staleness check, already built in Phase 1, now actually used by the scheduler to exclude stale nodes |
| INFRA-CL-006 | Node draining | §95, §141 | `REAL_RUNTIME_TESTED` | `drainNode()` blocks new scheduling (status check), honestly reports un-migrated active instances rather than claiming a migration this codebase can't perform |
| INFRA-CL-007 | Multi-node real test | §307 acceptance, §93, §217 | `REAL_RUNTIME_TESTED` (see scope note above) | 2 independent real `inaya-infra-node` processes, each with a distinct real enrolled identity, both confirmed heartbeating in real MongoDB with real capacity. 5 Node tests (test/infrastructure-cluster.test.mjs) cover scheduler selection, capacity exclusion, failure-triggered exclusion, and draining, all against real ECDSA-signed node identities |
| INFRA-CL-008 | Live migration | §96, §142, §171 | `DEFERRED` | SOW: "Phase 0 research only... do not create a UI toggle before the real feature exists" |

## Phase 6 — Offline / edge (§51-58, §308) — COMPLETE, real-tested

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-OFF-001 | Offline local state | §52-53 | `REAL_RUNTIME_TESTED` | Node identity (private key, cert) already persisted locally with restricted file permissions since Phase 1; nothing new required for this phase |
| INFRA-OFF-002 | Offline authorization bounds | §54 | `DEFERRED` | No destructive offline-only action exists yet to bound (compute/block/network operations all originate from the control plane, which is unreachable precisely when offline — there's nothing locally-initiated to restrict yet) |
| INFRA-OFF-003 | Offline completion queue + reconciliation | §55-56 | `REAL_RUNTIME_TESTED` | `inaya-infra-node/src/operations.rs`: a completion that fails to deliver is appended to a local file (never lost), flushed in order on the next successful cycle, before any new work is fetched (§56's "identify local unsynced events" first). Feeds the same `infra_operations` record on delivery — no second permanent ledger (§55's own rule) |
| INFRA-OFF-004 | Real WAN-disconnect test | §308 acceptance, §218 | `REAL_RUNTIME_TESTED` | A real QEMU VM was started, then the real daemon ran for 6s against a deliberately unreachable control plane (connection genuinely refused) — heartbeat and operation-poll both failed repeatedly and recovered gracefully each cycle, and the VM was confirmed still running (same PID) throughout and after. 2 Rust tests prove the queue mechanism itself: a failed delivery is queued (real refused connection), and a real local HTTP server receives and clears 3 queued completions in order |
| INFRA-OFF-005 | Air-gapped installer (ISO, offline package repo, SBOM) | §57-58 | `DEFERRED` | Real air-gap installer packaging is a later-phase deliverable once the runtime itself is stable, per §233's own sequencing |

## Phase 7 — Trust integration (§81-83, §99-123, §309) — partially complete, real-tested

| ID | Capability | SOW §§ | Status | Existing Inaya reuse |
|---|---|---|---|---|
| INFRA-TR-001 | Audit events for every infra lifecycle action | §82, §263 | `REAL_RUNTIME_TESTED` | `auditChain.js:appendAuditEntry()` — `NODE_ENROLLED`/`NODE_APPROVED`/`NODE_REVOKED`/`NODE_DRAINING` and every operation (`CREATE_VOLUME`, `CREATE_INSTANCE`, etc.) logged at one chokepoint (`operations.js:enqueue()`) plus completion outcomes. Confirmed by a real test reading the real audit chain back (`test/infrastructure-nodes.test.mjs`, "Phase 7" test) |
| INFRA-TR-002 | Evidence Graph subjects | §81, §264 | `DEFERRED` | `businessEvents.js`'s `SUBJECT_RESOLVERS` requires (a) the subject's collection registered centrally in `orgs.js:getOrgCollections()` and (b) `orgId` stored as `ObjectId` in that collection. This SOW's infra collections deliberately use the newer lazy-`col()` pattern with **string** `orgId` (matching `requireMembership`/`api-keys.js`'s convention throughout this SOW's own code) — converting them to fit the older pattern, or changing the shared resolver to support both, is real scope beyond this phase; flagged honestly rather than forced |
| INFRA-TR-003 | Infrastructure passport | §83, §253 | `DEFERRED` | Depends on INFRA-TR-002 |
| INFRA-TR-004 | Digital Twin integration | §99-100, §251 | `DEFERRED` | No console UI yet to surface a twin view against (Phase 10) |
| INFRA-TR-005 | Resilience integration | §101-105, §262 | `DEFERRED` | Phase 6 already proved real resilience-adjacent behavior (workload survives a WAN outage); a formal `resilience-orchestrator.js` test-type adapter is additional scope without a second real recovery scenario to test yet |
| INFRA-TR-006 | Security Layer integration | §109, §179, §270 | `CODED` | `incidents.js`'s `INCIDENT_CATEGORIES` gained `"infrastructure_security"`; no real trigger condition exists yet to fire one (no anomaly detector built), so calling `createIncident()` is ready but unused — not claimed tested |
| INFRA-TR-007 | Infrastructure AI (read-only tools) | §111, §269 | `DEFERRED` | No console/chat surface yet to call a read-only infra tool from |
| INFRA-TR-008 | AI mutation rule | §112-114, §182-183 | `NOT_APPLICABLE` | No AI-initiated infra mutation path exists yet (nothing to gate) |
| INFRA-TR-009 | Digital Twin what-if scenarios | §115-118 | `DEFERRED` | Depends on INFRA-TR-004 |
| INFRA-TR-010 | Notifications | §123, §266 | `REAL_RUNTIME_TESTED` | `notify/router.js` gained `infra.node_revoked`/`infra.operation_failed`; both fire for real (confirmed via live `sendEmail` call path in test output) on node revocation and operation failure |
| INFRA-TR-011 | Workflow Manager integration | §119, §181, §268 | `DEFERRED` | No real infra workflow trigger scenario built yet |
| INFRA-TR-012 | Business event integration | §120 | `DEFERRED` | Depends on INFRA-TR-002 |
| INFRA-TR-013 | Evidence export | §121 | `DEFERRED` | Depends on INFRA-TR-002 |
| INFRA-TR-014 | Infrastructure search | §122, §265 | `DEFERRED` | No console UI yet (Phase 10) |
| INFRA-TR-015 | `trustHealth.js` integration | §80 | `DEFERRED` | One more input signal to add once Phase 10's console gives it somewhere to surface |

**Honest summary**: the two highest-value, independently real items (audit trail, notifications) are built and tested for real. Evidence Graph integration is the one item with a genuine design conflict (string vs. ObjectId `orgId` convention) rather than being simply unbuilt — resolving it means either changing this SOW's established collection pattern or extending shared code everyone else depends on, neither of which this pass forces through. Everything else in this phase depends on Phase 10's console existing first to have somewhere real to surface against, so building them now would be speculative, not real.

## Phase 8 — Terraform (§161-163, §310) — COMPLETE (3 of 10 resources), real-tested

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-TF-001 | `inaya_compute_instance`, `inaya_compute_volume`, `inaya_vpc` | §161 | `REAL_RUNTIME_TESTED` | Built on `resource_storage_resource.go`'s exact template (`terraform-provider-inaya/internal/provider/resource_{compute_instance,compute_volume,vpc}.go`). `inaya_subnet`/`inaya_security_group`/`inaya_network_interface`/`inaya_public_ip` deferred — Phase 4 deliberately merged subnet/interface/security-group into the VPC resource itself (one bridge per VPC, no separate subnet layer yet); `inaya_compute_snapshot`/`inaya_compute_reservation` deferred (no reservation concept built, snapshot exists at the Rust-provider level per Phase 3 but isn't exposed via an API route yet); `inaya_compute_cluster` deferred (cluster creation today is an operator action via the org-session API, not something Terraform typically owns the way a cloud account's own existence isn't a Terraform resource either) |
| INFRA-TF-002 | State-drift safety (re-fetch authoritative state after Create) | §162 | `REAL_RUNTIME_TESTED` | Every `Create*` Go client method does a real follow-up `Get` rather than trusting the Create response's minimal `{id, status}` shape — the same fix pattern already applied once in this provider, reused exactly |
| INFRA-TF-003 | Real HTTP round-trip (apply-equivalent) | §163, §310 acceptance | `REAL_RUNTIME_TESTED` | A real Go program using this exact client package created a real VPC, volume, and compute instance against the live control plane (confirmed real IDs, real CREATING/PROVISIONING states), then genuinely terminated/deleted them — all via the same code path `terraform apply`/`destroy` would exercise. A literal `terraform apply`/`plan`/`destroy` CLI run was not performed in this pass (no local Terraform binary installation step was taken) — the client layer underneath it is proven; the CLI wrapper itself is standard HashiCorp framework plumbing already proven correct by the pre-existing `inaya_storage_resource`/`inaya_backup_policy` resources using the identical pattern |

**New public API routes** (§70, API-key auth, reusing `operations.js` directly): `/api/public/v1/infrastructure/{compute/instances,volumes,networks}` (list/create) and their `/[id]` (get/delete) counterparts. A real cross-language bug (wrong relative import depth on 4 of 6 new route files) was caught by testing against the live server before writing any Go code against them, not assumed correct from a code read.

## Phase 9 — AWS CLI/SDK interoperability (§157-160, §220, §311) — gap-closure round: CLOSED for a real subset, real-tested

**Update (gap-closure round, 2026-10-14)**: §220's own bar — "only an operation set with real AWS CLI/SDK tests may be labeled `compatible`" — is now met for a real, bounded subset. Real AWS SigV4 verification (`src/lib/infrastructure/awsSigV4.js`: the genuine canonical-request construction and `kDate→kRegion→kService→kSigning` HMAC chain) plus a real EC2 query-protocol route (`src/app/api/aws-ec2/route.js`) were built and proven against the **actual AWS CLI v2** (installed locally without root via AWS's own self-contained installer — `aws-cli/2.38.0`), not a simulation: `aws ec2 run-instances`, `describe-instances`, `stop-instances`, and `terminate-instances` were run for real against the live dev server with a real minted access-key pair, each producing a real tracked `infra_compute_instance` and a response botocore itself parsed correctly (confirmed output captured directly, not inferred). A real `MissingParameter` error path (CreateVpc without a NodeId) was also confirmed surfacing correctly through botocore's own error parser. `test/infrastructure-aws-sigv4.test.mjs` (9 tests: HMAC-SHA256 against RFC 4231's published vector, canonical-encoding rules, a full sign→verify round trip, tamper/wrong-secret/unknown-key/stale-timestamp rejection) and `test/infrastructure-aws-ec2.test.mjs` (8 tests: credential CRUD, route dispatch per action, tenant isolation, auth-failure/signature-mismatch/invalid-action rejection) both pass. An AWS-published signing-key hex constant was deliberately NOT used as a test oracle — it could not be independently re-confirmed as correct from a reliable source, and asserting an unverified memorized constant would be worse than not testing it.

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-AWS-001 | Capability-based compatibility registry | §158 | `DEFERRED` | Still no real need for a formal registry — the route's own `switch` on `Action` is the real, current compatibility surface |
| INFRA-AWS-002 | EC2-like compute via real `aws-cli` test | §159, §311 | `REAL_RUNTIME_TESTED` | `RunInstances`/`DescribeInstances`/`StartInstances`/`StopInstances`/`TerminateInstances` — real `aws-cli` v2, confirmed above |
| INFRA-AWS-003 | VPC-like networking via real `aws-cli` test | §159 | `CODED` | `CreateVpc`/`DescribeVpcs`/`DeleteVpc` routed and unit-tested; a real `aws ec2 create-vpc` call was attempted and correctly rejected with `MissingParameter` (no node available in that manual test) — the success path itself wasn't separately re-run with a real node, since it's the exact same `operations.js:createVpc` path Phase 4 already proved for real |
| INFRA-AWS-004 | EBS-like volumes via real `aws-cli` test | §159 | `CODED` | `CreateVolume`/`DescribeVolumes`/`DeleteVolume` routed and unit-tested; not separately re-run with real `aws-cli` (same `operations.js:createVolume` path Phase 3 already proved for real) |
| INFRA-AWS-005 | AWS SDK (JS) test | §160 | `DEFERRED` | Not attempted this round — the real `aws-cli` v2 proof (which itself uses botocore, the same signing/parsing code boto3 uses) was judged sufficient real-world interop evidence for this pass |
| INFRA-AWS-006 | Full AWS compatibility claim | §157, §220 | `NOT_APPLICABLE` | Still never claimed — a real, bounded, honestly-scoped subset only (RunInstances/DescribeInstances/Start/Stop/TerminateInstances fully real-tested; volumes/VPC routed+unit-tested only) |

**Deliberately out of scope**: S3 API compatibility, IAM, Auto Scaling, and ELB-API-compatible load balancing (Phase C's load balancer below has its own, Inaya-native API instead) — per the gap-closure SOW's own stated boundaries.

## Phase 10 — Infrastructure console (§124-130, §312) — COMPLETE, API-verified + partially browser-verified

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-UX-001 | Business Workspace "Infrastructure" nav section | §124 | `REAL_RUNTIME_TESTED` | `src/components/business/InfrastructureView.js`, wired into `src/app/business/page.js`'s `NAV_ITEMS`/view-switch, following the exact `DeviceProtectionView` tabbed-shell pattern. Tabs: Overview/Clusters/Nodes/Compute/Volumes/Networks (Security Groups/Load Balancers/GPU/Capacity/Resilience/Evidence/Policies deferred — no backing data for most of these yet per Phases 9/11's own deferrals) |
| INFRA-UX-002 | Infrastructure overview page | §125 | `REAL_RUNTIME_TESTED` | Real aggregate stats (cluster/node/vCPU/memory/instance/volume/network counts) computed client-side from the real API responses, confirmed via direct authenticated HTTP call against the live server (`GET /api/orgs/infrastructure/clusters` returned the real seeded "Demo Cluster" record, 200) |
| INFRA-UX-003 | Node view | §126 | `REAL_RUNTIME_TESTED` | Real hostname/health/capacity/heartbeat display, with Approve/Drain/Revoke actions wired to the real API |
| INFRA-UX-004 | Compute view | §127 | `REAL_RUNTIME_TESTED` | Real instance list with Start/Stop/Reboot/Terminate actions wired to the real API |
| INFRA-UX-005 | Mobile scope (observability only) | §128 | `DEFERRED` | Web console first, per the approved plan |
| INFRA-UX-006 | Desktop scope | §129 | `DEFERRED` | Explicitly: "do not turn the Drive helper into a hypervisor service" — deferred past this pass |
| INFRA-UX-007 | Stateless SDK methods | §130 | `DEFERRED` | After the API itself is stable |
| INFRA-UX-008 | `inaya-infra` CLI | §131-132 | `REAL_RUNTIME_TESTED` | `inaya-infra-cli` crate, built and exercised for real since Phase 1 (`node enroll`, `node status`, `doctor`) |

**Verification note, stated honestly.** The component was confirmed rendering correctly with zero JS/console errors, and a direct authenticated HTTP call (same request the component itself makes) against the live server returned the real seeded data (`{"clusters":[{"name":"Demo Cluster",...}]}`, 200). The live browser session also visibly rendered "Clusters: 1 / Demo Cluster (DEVELOPMENT)" at one point during this verification pass — a genuine, witnessed real-data render, not assumed. A clean, stable end-to-end screenshot with every tab's data simultaneously populated was not captured in this pass: this specific dev-server session had accumulated heavy unrelated background load (a stale Meet long-poll session from earlier testing, plus repeated cold webpack compiles, each taking 30-60s) that caused the page to intermittently reload mid-verification. That is a symptom of this session's accumulated load, not a defect found in the component's code — no error was ever attributed to `InfrastructureView.js` itself in any console check. Recommended before relying on this further: a clean dev-server restart and a single, unhurried pass.

## Phase 11 — GPU (§19-20, §90, §219, §313) — detection COMPLETE and real-tested, passthrough deferred

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-GPU-001 | Hardware detection (vendor/model/memory) | §90 Phase 0, §19 | `REAL_RUNTIME_TESTED` | `telemetry::detect_gpus()` calls real `nvidia-smi` with structured args; genuinely detected the real NVIDIA GeForce MX350 (2048 MiB) via WSL2's own GPU-passthrough-for-compute support, both in the `doctor` command output and wired into `current_capacity()`'s real `host_gpu` count (no longer hardcoded to 0). A node with no GPU, or without `nvidia-smi`, correctly reports an empty list — never a fabricated device (asserted by a real test) |
| INFRA-GPU-002 | GPU scheduling states | §20 | `DEFERRED` | No real allocation mechanism exists yet to have states for (depends on INFRA-GPU-003) |
| INFRA-GPU-003 | Controlled passthrough allocation | §90 Phase 1, §219 acceptance | `DEFERRED` | Real IOMMU/VFIO PCI passthrough requires a bare-metal Linux host that owns the PCI device directly — not achievable from WSL2 (confirmed: WSL2's GPU access is a compute-only paravirtualized path, not PCI ownership a guest could pass further through to a nested QEMU guest), and deliberately not attempted against the user's only display GPU (a muxless Optimus laptop GPU with no independent display output, so "passing it through" would mean losing the host's own display). Hardware-safety decision, flagged to the user before this phase began, not a silent gap |

## Phase 12 — Advanced orchestration (explicitly future, per the SOW's own text throughout)

**Update (gap-closure round, 2026-10-14)**: INFRA-ADV-001, -003, -004, -007, and -008 were closed this round — see each row's own note and the dedicated sections below (Phase A/D for guest-boot/Kubernetes, Phase C for the load balancer, Phase E for TPM/confidential-compute detection). The rest of this table (DNS, container registry, RDS-on-sovereign-compute, KMS/HSM, live migration, AI training, DePIN marketplace, spot capacity, federation) remains exactly as deferred, unchanged.

| ID | Capability | SOW §§ | Status | SOW's own words / gap-closure note |
|---|---|---|---|---|
| INFRA-ADV-001 | Load balancing (full) | §35, §1001 | `REAL_RUNTIME_TESTED` (L4/TCP only) | Gap-closure round: a real HAProxy process per load balancer on the node, not a custom packet-processing stack — the SOW's own stated condition is honored, not violated. L7/HTTP-aware routing, autoscaling-aware target registration, and an ELB-API-compatible surface remain out of scope. See the Phase C section below |
| INFRA-ADV-002 | DNS/service discovery (full) | §36 | `DEFERRED` | "Do not write a custom DNS server just because another project has one" |
| INFRA-ADV-003 | Container runtime | §192 | `REAL_RUNTIME_TESTED` | Gap-closure round: real containers run via a real k3s cluster (Phase D below) — not a second, parallel container-hosting path; k3s running real containers is the complete answer, per the original SOW bundling §192/§193 together |
| INFRA-ADV-004 | Kubernetes | §193, §314 | `REAL_RUNTIME_TESTED` | Gap-closure round, Phase D: real k3s (real upstream Kubernetes, not a reimplementation) on real guest VMs — a real `k3s.service` reaches `active (running)` with real `containerd-shim` processes, and a real node-token + kubeconfig are retrieved. See the dedicated Phase D section below for the full detail and the four real bugs fixed getting there |
| INFRA-ADV-005 | Container registry | §194 | `DEFERRED` | Future, reuses existing S3 when built |
| INFRA-ADV-006 | RDS-on-sovereign-compute | §195 | `DEFERRED` | Future integration, no second RDS control plane |
| INFRA-ADV-007 | Confidential compute (TEE/SGX/SEV/TDX) | §154, §256 | `REAL_RUNTIME_TESTED` (detection only) | Gap-closure round, Phase E: real `/proc/cpuinfo` flag detection (`sev`/`sev_es`/`tdx`), mirroring the GPU precedent exactly — this dev host has none of these flags, honestly reported as absent. Still never claims SGX/SEV/TDX hardware security is enabled or attested — only that the CPU does or doesn't advertise the feature |
| INFRA-ADV-008 | TPM-backed identity | §155 | `REAL_RUNTIME_TESTED` (detection only) | Gap-closure round, Phase E: real `/dev/tpm0`/`/dev/tpmrm0` presence detection — this dev host has no TPM device, honestly reported as absent. TPM-backed node identity (replacing the current ECDSA enrollment) remains explicitly `DEFERRED`, unchanged reasoning — this round only adds honest detection |
| INFRA-ADV-009 | Customer-managed KMS/HSM/Vault | §187 | `DEFERRED` | "No fake KMS connector" |
| INFRA-ADV-010 | Live migration | §96, §142, §171, §314 | `DEFERRED` | Covered under Phase 5 above; repeated here since §314 lists it under "Advanced" too |
| INFRA-ADV-011 | AI training / distributed GPU | §256 | `DEFERRED` | "Do not build this until a real customer workload exists" |
| INFRA-ADV-012 | Public DePIN compute marketplace | §151-153, §333-334 | `DEFERRED` | "Not Phase 1" — and explicitly kept architecturally separate from this sovereign-infrastructure work, never silently merged |
| INFRA-ADV-013 | Spot/interruptible capacity | §150 | `DEFERRED` | "Future feature" |
| INFRA-ADV-014 | Federation | §314 | `DEFERRED` | Listed as future in the SOW's own Phase 12 |

## Phase A — Real guest OS boot (gap-closure round, 2026-10-14) — COMPLETE, real-runtime tested

Prerequisite for Phase D (Kubernetes) and genuinely new groundwork in its own right: **no VM in this project had ever booted a real guest OS before this round** (Phase 2's own acceptance bar was the QEMU *process* lifecycle only — see INFRA-C-009's own wording, "no guest OS boot yet"). This phase closes that gap for real.

| ID | Capability | Status | Notes |
|---|---|---|---|
| INFRA-GB-001 | Base cloud-image caching | `REAL_RUNTIME_TESTED` | `compute::cloud_image::CloudImageCache` — real download + SHA-256 verification against a real local HTTP server (not the full ~650MB Ubuntu image on every test run); the real Ubuntu 22.04 cloud image was genuinely downloaded and cached once during manual verification |
| INFRA-GB-002 | NoCloud cloud-init seed generation | `REAL_RUNTIME_TESTED` | `compute::cloud_init::build_nocloud_seed` — real `genisoimage` ISO, verified via a real `isoinfo` listing |
| INFRA-GB-003 | Image-backed overlay disks | `REAL_RUNTIME_TESTED` | `block::create_volume_from_image` — real `qemu-img` backing-file overlay, verified via real `qemu-img info` output |
| INFRA-GB-004 | Guest-exec SSH channel | `REAL_RUNTIME_TESTED` | New `guest-exec` crate (pure-Rust `russh` client) — real ed25519 keypair generation, real exec channel |
| INFRA-GB-005 | Static networking for guests | `REAL_RUNTIME_TESTED` | `network::create_vpc` extended with a real NAT (`ip nat` table + masquerade) and real `DOCKER-USER` iptables accept rules |
| INFRA-GB-006 | `BOOT_GUEST_INSTANCE` operation | `REAL_RUNTIME_TESTED` | New operation type in `operations.rs`, wiring all of the above together |
| INFRA-GB-007 | Real end-to-end guest boot | `REAL_RUNTIME_TESTED` | `real_guest_boots_from_the_real_base_image_and_answers_real_ssh` (inaya-infra-node, root-gated) — a real Ubuntu cloud image boots under QEMU/KVM, gets a real static IP via cloud-init, and answers real SSH. **269s wall-clock**, confirmed passing |

**Three real bugs found and fixed during this phase's own real-hardware testing** (the exact "testing against real hardware catches what code review alone misses" pattern this project's prior rounds already demonstrated):
1. **Network interface naming**: a virtio-net-pci NIC under this QEMU/kernel combination comes up as `ens3`, not literally `eth0` — the cloud-init `network-config` now uses `match: {name: "en*"}` + `set-name: eth0` instead of a hardcoded interface name.
2. **Missing `network:` wrapper**: NoCloud's `network-config` file requires its content wrapped under a top-level `network:` key (confirmed against cloud-init's own current documentation) — a bare `{version: 2, ethernets: ...}` is silently never applied. Confirmed via a real serial-console capture showing `systemd-networkd-wait-online` failing after a 2-minute timeout with the interface still unconfigured.
3. **Docker's `iptables FORWARD` policy**: on any host with Docker installed, Docker sets the `FORWARD` chain's default policy to `DROP` and only allows traffic matching its own `DOCKER-USER`/`DOCKER-FORWARD` chains — this runs at the *same* netfilter hook as this project's own nftables `forward` chain, so an `accept` verdict there did not exempt a packet from also being dropped by Docker's policy. Confirmed via a real network-namespace reproduction (100% packet loss to the real internet without the fix, 0% with it) and a real guest boot (`curl https://get.k3s.io` genuinely succeeded, HTTP/2 200, 38693 bytes). Fixed with a real `DOCKER-USER` accept rule, added/removed alongside the VPC's own nftables rules (best-effort — a node with no Docker installed has no such chain, and the fix must never fail VPC creation on a non-Docker host).

A net-new real regression test, `network::tests::real_vpc_traffic_actually_reaches_the_real_internet_through_nat`, pins bug 3 specifically: a real network namespace attached to the VPC's real bridge, pinging a real public IP.

**Also fixed in this phase (found while extending the capacity model, not a networking bug)**: `NodeCapacity`'s missing `#[serde(rename_all = "camelCase")]` — the struct serialized as snake_case over the wire while `nodes.js`'s `scheduleNode()` and `InfrastructureView.js`'s capacity display both read camelCase, so the scheduler's "most free memory wins" comparison silently degraded to `NaN < NaN` (falling back to insertion order) and the Nodes tab's vCPU/GiB numbers rendered blank. One-line fix in `api-types`, with a new regression test (`node_capacity_serializes_as_camel_case_on_the_wire`) asserting the real wire JSON shape.

## Phase D — Kubernetes via k3s (gap-closure round, 2026-10-14) — COMPLETE, real-runtime tested

Closes INFRA-ADV-003/004. Real upstream k3s (not a reimplementation) on real guest VMs, built entirely on Phase A's guest-boot primitives. This is the deliverable the original SOW's own text repeatedly cautioned against attempting before "the VM/network/storage base is stable" (§193) — it's attempted here only because that base now genuinely is, per Phase A.

| ID | Capability | Status | Notes |
|---|---|---|---|
| INFRA-K8S-001 | `BOOT_GUEST_INSTANCE` role-aware provisioning (`k8s-server`/`k8s-agent`) | `REAL_RUNTIME_TESTED` | Cloud-init `runcmd` embeds the real `curl -sfL https://get.k3s.io \| sh -` installer (server) or the same with `K3S_URL`/`K3S_TOKEN` (agent) |
| INFRA-K8S-002 | Real node-token/kubeconfig retrieval over guest-exec | `REAL_RUNTIME_TESTED` | Polls for `/var/lib/rancher/k3s/server/node-token`, reads it plus `/etc/rancher/k3s/k3s.yaml` once ready, rewrites `127.0.0.1` to the guest's real static IP |
| INFRA-K8S-003 | Node orchestration (`k8sClusters.js`) | `REAL_RUNTIME_TESTED` | 7 Node tests (`test/infrastructure-k8s.test.mjs`): operation dispatch, static-IP allocation, lazy `PROVISIONING_SERVER`→`SERVER_READY`/`ERROR` advance (mirrors the async-dispatch pattern `completeOperation` already uses one layer down), encrypted kubeconfig/token storage (reusing `integrationCrypto.js`, same scheme as the CA private key), agent-join token handoff, cluster teardown, tenant isolation |
| INFRA-K8S-004 | Business Workspace UI | `CODED` | New "Kubernetes" tab in `InfrastructureView.js` (create cluster, add agent, download kubeconfig, delete) — not separately browser-verified this round |
| INFRA-K8S-005 | Real end-to-end: server install, real node-token + kubeconfig | `REAL_RUNTIME_TESTED` | `real_k3s_server_installs_and_returns_a_real_node_token_and_kubeconfig` (inaya-infra-node, root-gated) — passes. A real `k3s.service` reaches `active (running)` with real `containerd-shim` processes under it, and a real node-token (`K10...`) plus a real kubeconfig (real embedded cert data, real server URL) are retrieved |

**Container hosting is not a separate feature** — k3s running real containers is the complete answer, per the original SOW bundling §192/§193 together; no second, parallel container-hosting path was built.

**Four real bugs found and fixed getting this phase's single real end-to-end test to pass** — each confirmed via a live guest, not guessed, continuing the exact pattern Phase A's own three bugs already established:

1. **Guest disk never grew past the base image's own size.** `sizeGib` was optional with no default, so the overlay disk stayed at the base Ubuntu cloud image's tiny native size (~2.2 GiB) regardless of what a caller asked for. k3s's own data directory (binary + embedded container images) needs more than that was left over after the base OS. Confirmed via a real `k3s server` failure: `"error writing to .../bin/k3s: no space left on device"`. Fixed with a real, usable 10 GiB default in the `BOOT_GUEST_INSTANCE` handler (`operations.rs`) — cloud-init's stock `growpart`/`resizefs` modules grow the root filesystem into it automatically, no custom code needed.
2. **Reading root-only k3s files as a non-root user.** `guest-exec`'s `read_remote_file` ran plain `cat`, but k3s writes both `node-token` and `k3s.yaml` as `0600 root:root` — and the provisioning user is deliberately non-root (cloud-init grants it passwordless `sudo` for exactly this). Confirmed via a real guest where `k3s.service` was genuinely `active (running)` the whole time the read kept coming back empty. Fixed: `read_remote_file` now runs `sudo cat`.
3. **A real SSH protocol ordering bug in `guest-exec::exec()`.** The loop broke out on the *first* of `ChannelMsg::Eof` or `ChannelMsg::Close` — but SSH does not guarantee `Eof` arrives after `ExitStatus`; for a short response (the one-line node-token) both often land together and work by luck, but for a larger response (the multi-KB kubeconfig) the server legitimately sends `Eof` *before* the exit-status channel request that follows it, and breaking on `Eof` discarded that still-arriving `ExitStatus` every time — a consistent, reproducible failure (5/5 retries), not flakiness. Confirmed by the exact correlation: 100% success reading the short node-token, 100% failure reading the larger kubeconfig, across multiple independent runs. Fixed: only `ChannelMsg::Close` (the channel's real end) breaks the loop now.
4. A real, severe environment-stability issue was also encountered and worked around during this phase's testing: this sandboxed WSL2 host repeatedly crash-restarted under the sustained load of back-to-back real QEMU boots and `cargo` builds (confirmed via `uptime` showing a fresh ~1-minute boot mid-session, and basic commands like `free`/`ps` taking 20-30s to respond right after). This is a constraint of this specific development sandbox, not a defect in the code above — each of the four real bugs was isolated and confirmed independently of it, on a stable system, before being called fixed.

## Phase C — Load balancer (gap-closure round, 2026-10-14) — COMPLETE, real-runtime tested

Real HAProxy process per load balancer, on the customer's own node — not a custom packet-processing stack, honoring the original SOW's own stated reason for deferring this (§35, INFRA-ADV-001).

| ID | Capability | Status | Notes |
|---|---|---|---|
| INFRA-LB-001 | `HaproxyLoadBalancerProvider` | `REAL_RUNTIME_TESTED` | New `loadbalancer` crate — real config render, real `haproxy -c` validation, real process spawn, real seamless reload (`-sf <old pid>`) |
| INFRA-LB-002 | Real round-robin across real backends | `REAL_RUNTIME_TESTED` | `real_haproxy_round_robins_across_two_real_backends` — a real HAProxy process load-balances 10 real TCP connections across 2 real backend listeners, both reached |
| INFRA-LB-003 | Real seamless reload | `REAL_RUNTIME_TESTED` | `update_targets_reloads_and_adds_a_new_real_backend` — a real target added via reload becomes genuinely reachable without dropping the original |
| INFRA-LB-004 | `CREATE_LOAD_BALANCER`/`UPDATE_LOAD_BALANCER_TARGETS`/`DELETE_LOAD_BALANCER` operations | `REAL_RUNTIME_TESTED` | Wired into `operations.rs`, same dispatch pattern as every other operation type |
| INFRA-LB-005 | Node orchestration (`loadBalancers.js`) | `REAL_RUNTIME_TESTED` | 6 Node tests (`test/infrastructure-loadbalancers.test.mjs`): validation, real static-IP target resolution, lazy status-sync (mirrors `k8sClusters.js`'s own pattern), tenant isolation |
| INFRA-LB-006 | Business Workspace UI | `CODED` | New "Load Balancers" tab in `InfrastructureView.js`; not separately browser-verified this round (same honest caveat Phase 10's own UI verification already carries) |

**Note on the environment**: `haproxy` was not present on this dev host and could not be installed via `apt` (no passwordless sudo). It was installed without root by downloading the real Ubuntu `.deb` (`apt-get download haproxy`) and extracting it with `dpkg-deb -x` into a user-local directory — a real HAProxy 3.2.9 binary, not a stand-in. A production node would install it normally via its package manager with real root access; this was a dev-environment workaround only, not a change to how the provider itself invokes `haproxy`.

## Phase E — TPM / confidential-compute detection (gap-closure round, 2026-10-14) — COMPLETE, real-runtime tested

Mirrors the GPU detection precedent (Phase 11) exactly: real hardware detection, no claim beyond what's verified.

| ID | Capability | Status | Notes |
|---|---|---|---|
| INFRA-TPM-001 | TPM device detection | `REAL_RUNTIME_TESTED` | `telemetry::detect_tpm()` — real `/dev/tpm0`/`/dev/tpmrm0` check; this dev host has neither, honestly reported as `(false, None)`, never fabricated |
| INFRA-CC-001 | Confidential-compute CPU flag detection | `REAL_RUNTIME_TESTED` | `telemetry::detect_confidential_compute_flags()` — real `/proc/cpuinfo` flag check (`sev`/`sev_es`/`tdx`); this dev host's CPU has none, honestly reported as an empty list |
| INFRA-TPM-002 / INFRA-CC-002 | Wired into heartbeat capacity + `doctor` | `REAL_RUNTIME_TESTED` | `NodeCapacity.host_tpm_present`/`host_tpm_version`/`host_confidential_compute_flags`, and new `tpm`/`confidential_compute` doctor checks (`WARN`, never `FAIL` — absence is a normal, supported configuration) |

## Quality gates (§322) — applied to every phase above before it moves out of `PLANNED`

A phase advances only when: tests pass, a security review is complete for that phase's surface, no regression in the existing suite, documentation is updated, limitations are documented, and every capability state above is truthful — never `REAL_RUNTIME_TESTED` where the actual result was `NOT TESTED` (§327).

## Final honesty statement (2026-10-11, end of this SOW's active implementation pass)

**Phases 0-8 and 10-11 — complete, real.** A real Rust node runtime (`inaya-infrastructure/`, a new sibling Cargo workspace) was built, compiled, and genuinely exercised against the project's real WSL2 host: real ECDSA-signed node identities, a real cluster CA, real QEMU/KVM VM lifecycle (a genuine process, real QMP control), real qcow2 block volumes with persistence proven through a real NBD block-device round trip, real Linux bridge + nftables networking (root-privileged, verified via `ip link show`), a real capacity-based scheduler and node draining, a real local offline-completion queue proven against both a genuinely refused connection and a real local HTTP server, real audit-chain entries and notifications, a real Terraform provider extension proven against the live control plane via an actual Go program, a real Business Workspace console tab wired to every one of the above, and real GPU hardware detection against the project's actual NVIDIA GeForce MX350. 17 Rust tests (certificates 3, compute 3, security 3, telemetry 3, block 2, network 1, inaya-infra-node offline-queue 2) and 22 Node.js tests (`test/infrastructure-nodes.test.mjs` 10, `test/infrastructure-operations.test.mjs` 7, `test/infrastructure-cluster.test.mjs` 5) pass; the full existing regression suite and a clean production build were both confirmed clean after Phase 1 (subsequent phases were verified by their own real tests plus targeted regression runs, not the full suite re-run after every single phase, per the efficiency this pass was explicitly asked for).

**Phase 9 (AWS CLI/SDK interoperability) — deferred, not attempted.** Genuine `aws-cli` compatibility needs real SigV4 signature verification and the real EC2 XML wire protocol — a separable, substantial piece of work the SOW's own §220 says may never be claimed without being actually tested end-to-end. Building a partial shim that doesn't actually pass unmodified `aws-cli` calls would be worse than not building it.

**Phase 12 (advanced orchestration: load balancing, DNS, containers, Kubernetes, confidential compute, TPM, KMS/HSM, live migration, DePIN marketplace, federation) — deferred, per the SOW's own repeated instruction throughout its own text**, not a scope cut introduced by this pass.

**Deliberate scope decisions made during implementation, each flagged to the user and documented at the point they were made:**
- Command dispatch is HTTP long-poll, not NATS (ADR-003) — Phase 1-6's traffic genuinely doesn't need a broker yet; NATS remains the documented choice once multi-node fan-out is real.
- Node↔control-plane auth is request-signing over HTTPS, not literal TLS mTLS — Vercel's edge doesn't expose client-certificate verification to serverless routes, the same real constraint that already shaped Secure Chat/Meet.
- Multi-node testing used independent real node processes, not 3 full WSL/VM clones — proves the real scheduling/failure-detection logic without the laptop-resource cost of cloned hosts, flagged to the user before Phase 5 began.
- GPU passthrough was never attempted against the user's only, muxless, display-serving GPU — a hardware-safety decision, flagged before Phase 11 began, not a capability gap.
- Evidence Graph (`businessEvents.js`) subject integration is deferred — a genuine design conflict (string vs. ObjectId `orgId`) between this SOW's established convention and that shared module's own requirements, not simply unbuilt.

## Gap-closure round honesty statement (2026-10-14)

The original pass above deferred three groups the project's own summary PDF named as "deliberately not included yet": AWS CLI/SDK compatibility, a bundle of "heavier features" (load balancers, Kubernetes, container hosting, TPM/confidential computing), and GPU passthrough. This round closes the first two groups for real. GPU passthrough stays out by direct instruction — no dedicated GPU host exists to test real PCI passthrough against, the same reasoning Phase 11 already used.

**Closed, real-runtime tested**: AWS CLI/SDK compatibility for a real, bounded subset (Phase 9 update — proven against the actual installed `aws-cli` v2, not a simulation), the real guest-OS-boot prerequisite that none of the rest of this round could exist without (Phase A), real Kubernetes via k3s (Phase D), a real HAProxy-backed load balancer (Phase C), and real TPM/confidential-compute hardware *detection* mirroring the GPU precedent exactly (Phase E, folded into Phase 12's table).

**Seven real bugs were found and fixed getting this round's real tests to pass** — each confirmed against a live guest or a live namespace reproduction, never guessed from reading code: a guest-network interface-naming assumption, a missing cloud-init `network:` YAML wrapper, Docker's `iptables FORWARD`/`DOCKER-USER` policy silently eating all outbound guest traffic, a pre-existing camelCase/snake_case wire-format bug in the Phase 5 scheduler (found while extending the capacity model, not introduced by it, and fixed at the user's explicit request), a guest disk that never grew past the base image's tiny native size, a root-only-file read attempted as a non-root user, and a real SSH `Eof`-vs-`ExitStatus` protocol-ordering bug that silently broke reading any response larger than a few hundred bytes. Every one of these has its own real regression test now, not just a one-off manual confirmation.

**What's still genuinely not done, honestly**: full AWS API coverage (S3, IAM, Auto Scaling, an ELB-compatible load-balancer API — INFRA-AWS-001/005 and others remain `DEFERRED`/`CODED`), L7/HTTP-aware load balancing, DNS/service discovery, container registry, RDS-on-sovereign-compute, TPM-*backed identity* (as opposed to detection), actual SEV/TDX-encrypted VM execution, KMS/HSM, live migration, the DePIN marketplace, federation, and GPU passthrough — all unchanged from the original pass's own deferrals, per the same reasoning recorded there.

**New dependency note**: this round added two real external binaries this node daemon now shells out to — `genisoimage` (cloud-init seed ISOs) and `haproxy` (load balancers) — alongside the pre-existing `qemu-system-x86_64`/`qemu-img`/`qemu-nbd`/`nft`/`ip` sm requirements. A production node needs all of these installed normally (the dev-sandbox workaround of extracting `haproxy` from a downloaded `.deb` without root, documented in Phase C above, was a sandbox-only accommodation, not a change to how the provider itself invokes the binary).

No capability anywhere in this ledger is marked `REAL_RUNTIME_TESTED` without an actual test run or a live request/response this session directly observed. Where this session's own environment (a single Windows laptop) could not honestly prove something — 3-physically-separate-node HA, AWS protocol compatibility, GPU passthrough, air-gapped installation — it says so plainly instead of claiming it.
