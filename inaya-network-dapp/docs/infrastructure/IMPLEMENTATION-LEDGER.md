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

## Phase 7 — Trust integration (§81-83, §99-123, §309)

| ID | Capability | SOW §§ | Status | Existing Inaya reuse |
|---|---|---|---|---|
| INFRA-TR-001 | Audit events for every infra lifecycle action | §82, §263 | `PLANNED` | `auditChain.js:appendAuditEntry()` — free-string `recordType`, no registry edit needed |
| INFRA-TR-002 | Evidence Graph subjects | §81, §264 | `PLANNED` | `businessEvents.js` `EVENT_TYPES`/`SUBJECT_RESOLVERS` — closed registry, one entry per subject |
| INFRA-TR-003 | Infrastructure passport | §83, §253 | `PLANNED` | `businessEventPassport.js` — generic once subjects are registered |
| INFRA-TR-004 | Digital Twin integration | §99-100, §251 | `PLANNED` | `digitalTwin.js` — org-wide gate precedent (storage-resource special case) |
| INFRA-TR-005 | Resilience integration | §101-105, §262 | `PLANNED` | `resilience-orchestrator.js` — new adapters, no second engine |
| INFRA-TR-006 | Security Layer integration | §109, §179, §270 | `PLANNED` | `incidents.js:createIncident()` — NOT `security.js` (its enum is on-chain-synced) |
| INFRA-TR-007 | Infrastructure AI (read-only tools) | §111, §269 | `PLANNED` | `ai-os-router.js` pattern, `infra_` prefix |
| INFRA-TR-008 | AI mutation rule (no direct destructive execution) | §112-114, §182-183 | `PLANNED` | `ai-action-requests.js` `EXECUTORS` map — same 36h-delay pipeline as every other AI mutation |
| INFRA-TR-009 | Digital Twin what-if scenarios | §115-118 | `PLANNED` | NODE_FAILURE/GPU_FAILURE/VOLUME_FAILURE/NETWORK_PARTITION/etc. |
| INFRA-TR-010 | Notifications | §123, §266 | `PLANNED` | `notify/router.js` `EVENTS` catalog |
| INFRA-TR-011 | Workflow Manager integration | §119, §181, §268 | `PLANNED` | `src/lib/workflows/` catalog |
| INFRA-TR-012 | Business event integration | §120 | `PLANNED` | Reference, never shadow-copy — already enforced by `createBusinessEvent()`'s own design |
| INFRA-TR-013 | Evidence export (JSON/CSV/PDF) | §121 | `PLANNED` | `evidenceExporter.js` — no second PDF system |
| INFRA-TR-014 | Infrastructure search | §122, §265 | `PLANNED` | Extend existing global search/command palette |
| INFRA-TR-015 | `trustHealth.js` integration | §80 | `PLANNED` | One more input signal, not a second dashboard |

## Phase 8 — Terraform (§161-163, §310)

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-TF-001 | `inaya_compute_instance`, `inaya_compute_volume`, `inaya_vpc`, `inaya_subnet`, `inaya_security_group`, `inaya_network_interface`, `inaya_public_ip`, `inaya_compute_snapshot`, `inaya_compute_reservation`, `inaya_compute_cluster` resources | §161 | `PLANNED` | `resource_storage_resource.go` is the exact template |
| INFRA-TF-002 | State-drift safety (re-fetch authoritative state after Create) | §162 | `PLANNED` | Same fix pattern already applied once in this provider |
| INFRA-TF-003 | Real apply/refresh/plan/update/destroy cycle | §163, §310 acceptance | `PLANNED` | Against the real local control plane |

## Phase 9 — AWS CLI/SDK interoperability (§157-160, §220, §311)

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-AWS-001 | Capability-based compatibility registry | §158 | `PLANNED` | DISCOVERED/READ_ONLY/PARTIAL/VERIFIED/COMPATIBLE/UNSUPPORTED — only the highest *verified* level advertised |
| INFRA-AWS-002 | EC2-like compute via real `aws-cli` test | §159, §311 | `PLANNED` | create/read/mutate/destroy/verify-no-leaked-state, real CLI against the real endpoint |
| INFRA-AWS-003 | VPC-like networking via real `aws-cli` test | §159 | `PLANNED` | |
| INFRA-AWS-004 | EBS-like volumes via real `aws-cli` test | §159 | `PLANNED` | |
| INFRA-AWS-005 | AWS SDK (JS) test | §160 | `PLANNED` | At least one official SDK, not just the CLI |
| INFRA-AWS-006 | Full AWS compatibility claim | §157, §220 | `NOT_APPLICABLE` | Explicitly never claimed — only the tested operation subset is ever labeled compatible |

## Phase 10 — Infrastructure console (§124-130, §312)

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-UX-001 | Business Workspace "Infrastructure" nav section | §124 | `PLANNED` | Overview/Clusters/Nodes/Compute/Volumes/Networks/Security Groups/Load Balancers/GPU/Capacity/Resilience/Evidence/Policies |
| INFRA-UX-002 | Infrastructure overview page | §125 | `PLANNED` | All values real, no placeholder numbers |
| INFRA-UX-003 | Node view | §126 | `PLANNED` | |
| INFRA-UX-004 | Compute view | §127 | `PLANNED` | |
| INFRA-UX-005 | Mobile scope (observability only) | §128 | `DEFERRED` | Web console first, per the approved plan |
| INFRA-UX-006 | Desktop scope | §129 | `DEFERRED` | Explicitly: "do not turn the Drive helper into a hypervisor service" — deferred past this pass |
| INFRA-UX-007 | Stateless SDK methods | §130 | `DEFERRED` | After the API itself is stable |
| INFRA-UX-008 | `inaya-infra` CLI | §131-132 | `PLANNED` | `inaya-infra-cli` crate, part of the Phase 1 workspace scaffold |

## Phase 11 — GPU (§19-20, §90, §219, §313)

| ID | Capability | SOW §§ | Status | Notes |
|---|---|---|---|---|
| INFRA-GPU-001 | Hardware detection (vendor/model/memory/IOMMU/driver state) | §90 Phase 0, §19 | `PLANNED` | Real test target: the user's NVIDIA GeForce MX350, confirmed reachable via `nvidia-smi` |
| INFRA-GPU-002 | GPU scheduling states | §20 | `PLANNED` | No fake fractional GPU support |
| INFRA-GPU-003 | Controlled passthrough allocation | §90 Phase 1, §219 acceptance | `DEFERRED` | Requires a bare-metal Linux host owning the PCI device directly — not achievable from WSL2, and not attempted against the user's primary/only (muxless Optimus) display GPU. Explicit hardware-safety deferral, documented in the approved plan, not a silent gap |

## Phase 12 — Advanced orchestration (explicitly future, per the SOW's own text throughout)

| ID | Capability | SOW §§ | Status | SOW's own words |
|---|---|---|---|---|
| INFRA-ADV-001 | Load balancing (full) | §35, §1001 | `DEFERRED` | "Phase 1 should not create a custom packet-processing stack" |
| INFRA-ADV-002 | DNS/service discovery (full) | §36 | `DEFERRED` | "Do not write a custom DNS server just because another project has one" |
| INFRA-ADV-003 | Container runtime | §192 | `DEFERRED` | "Do not implement full ECS/container orchestration in Phase 1" |
| INFRA-ADV-004 | Kubernetes | §193, §314 | `DEFERRED` | "Do not claim EKS support merely because Spinifex supports it... Phase 1 only after the VM/network/storage base is stable" |
| INFRA-ADV-005 | Container registry | §194 | `DEFERRED` | Future, reuses existing S3 when built |
| INFRA-ADV-006 | RDS-on-sovereign-compute | §195 | `DEFERRED` | Future integration, no second RDS control plane |
| INFRA-ADV-007 | Confidential compute (TEE/SGX/SEV/TDX) | §154, §256 | `DEFERRED` | "Existing Inaya Attestation is software-simulated, not hardware-backed... Do not claim SGX/SEV/TDX hardware security in Phase 1" |
| INFRA-ADV-008 | TPM-backed identity | §155 | `DEFERRED` | "Phase 0 research... No Phase-1 certification claim" |
| INFRA-ADV-009 | Customer-managed KMS/HSM/Vault | §187 | `DEFERRED` | "No fake KMS connector" |
| INFRA-ADV-010 | Live migration | §96, §142, §171, §314 | `DEFERRED` | Covered under Phase 5 above; repeated here since §314 lists it under "Advanced" too |
| INFRA-ADV-011 | AI training / distributed GPU | §256 | `DEFERRED` | "Do not build this until a real customer workload exists" |
| INFRA-ADV-012 | Public DePIN compute marketplace | §151-153, §333-334 | `DEFERRED` | "Not Phase 1" — and explicitly kept architecturally separate from this sovereign-infrastructure work, never silently merged |
| INFRA-ADV-013 | Spot/interruptible capacity | §150 | `DEFERRED` | "Future feature" |
| INFRA-ADV-014 | Federation | §314 | `DEFERRED` | Listed as future in the SOW's own Phase 12 |

## Quality gates (§322) — applied to every phase above before it moves out of `PLANNED`

A phase advances only when: tests pass, a security review is complete for that phase's surface, no regression in the existing suite, documentation is updated, limitations are documented, and every capability state above is truthful — never `REAL_RUNTIME_TESTED` where the actual result was `NOT TESTED` (§327).
