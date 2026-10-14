# Sovereign Infrastructure — Gap Closure SOW

Status: DRAFT — awaiting plan approval
Prepared: 2026-10-13
Supersedes: nothing. Extends the original Sovereign Infrastructure Fabric SOW
(`INAYA_Spinifex_Sovereign_Infrastructure_ClaudeCode_SOW.md` — not checked into
this repo) and its `IMPLEMENTATION-LEDGER.md` DEFERRED items.

## 0. Why this document exists

`IMPLEMENTATION-LEDGER.md` left three capability groups `DEFERRED` after Phase 1:
AWS CLI/SDK compatibility (INFRA-AWS-001..006), the "heavier features" bundle —
load balancers (INFRA-ADV-001/INFRA-NET-009), Kubernetes (INFRA-ADV-004),
container hosting (INFRA-ADV-003) — and hardware-backed identity/confidential
computing (INFRA-ADV-007/008). GPU passthrough (INFRA-ADV-006-equivalent) stays
`DEFERRED` **by explicit instruction this round** — no dedicated GPU host exists
to test real PCI passthrough against, same reasoning the original SOW already
used to defer it, and re-attempting it without real hardware would repeat the
exact mistake this project's own culture is built around avoiding ("don't claim
what wasn't run against something real").

Everything below follows the existing project convention: every claim ships
with the automated test that proves it, every capability is labeled `CODED`,
`REAL_RUNTIME_TESTED`, or `DEFERRED` in the ledger — never silently upgraded —
and a capability that can't be tested against real hardware in this environment
is scoped down to what honestly can be, with the reason on record.

## 1. AWS CLI/SDK compatibility (closes INFRA-AWS-001..006)

**Goal**: the real `aws` CLI and `boto3`, pointed at Inaya's control plane via
`--endpoint-url`, can drive the existing compute/volume/VPC resources that
`operations.js` already manages. Not full AWS API coverage — a real, tested
subset, honestly scoped.

- **AWS SigV4 request verification** — new `src/lib/infrastructure/awsSigV4.js`.
  Verifies the `Authorization: AWS4-HMAC-SHA256 ...` header against an
  org-scoped access-key/secret pair (new `infra_aws_credentials` collection,
  keyed like the existing public-API-key pattern). Real canonical-request
  construction, not a lookalike — tested against fixed AWS test vectors (the
  published AWS SigV4 test suite) plus a real signed request from boto3 itself.
- **EC2 Query API subset** — new route `src/app/api/aws-ec2/route.js` (single
  entrypoint, `Action` query/form param dispatch, matching how EC2's own query
  API works). Actions: `RunInstances`, `DescribeInstances`, `StartInstances`,
  `StopInstances`, `TerminateInstances`, `CreateVolume`, `DescribeVolumes`,
  `DeleteVolume`, `CreateVpc`, `DescribeVpcs`, `DeleteVpc`. Each maps straight
  onto the existing `operations.js`/`nodes.js` functions — no new state model,
  just a wire-format adapter. Responses are real EC2-shaped XML (not JSON),
  since that's what botocore's EC2 model parses.
- **What's explicitly out of scope**: S3 API compatibility (Inaya's own
  storage already has its own API — bridging it to S3's wire format is a
  separate, later decision, not bundled in here), IAM, Auto Scaling, ELB API
  (the load balancer in §2 gets an Inaya-native API, not an AWS ELB-compatible
  one), and any EC2 action beyond the list above.
- **Proof**: real `aws ec2 run-instances --endpoint-url ... --profile inaya-test`
  (configured with the issued access key/secret) actually creates a tracked
  `infra_compute_instance`, visible back through the existing org-session route
  and the Infrastructure UI. `aws ec2 describe-instances` lists it. This is the
  bar — not a unit test that reimplements AWS's own parser.

## 2. Load balancer (closes INFRA-ADV-001/INFRA-NET-009)

**Goal**: an L4 TCP load balancer across instances inside one VPC, deployed on
the customer's own node — not a new packet-processing stack (the original
SOW's own stated reason for deferring this; still true).

- **Mechanism**: reuse the existing `inaya-infra-node` agent's operation
  executor. New operation type `CREATE_LOAD_BALANCER` renders and starts a real
  **HAProxy** process (TCP mode) on the node, config generated from the target
  instance list + health-check interval, written to a per-LB directory, managed
  (reload on membership change, stop on delete) the same way `QemuKvmProvider`
  manages QEMU processes — not a custom proxy implementation.
- **New crate**: `inaya-infrastructure/crates/loadbalancer/src/lib.rs` —
  `HaproxyLoadBalancerProvider` (`create`/`update_targets`/`delete`), argv-only
  process control through the existing `security::run_command` hardened
  helper.
- **New collection**: `infra_load_balancers` (`{lbId, orgId, vpcId, nodeId,
  listenPort, targets[], healthCheck, status}`), CRUD in
  `src/lib/infrastructure/loadBalancers.js`, routes under
  `src/app/api/orgs/infrastructure/load-balancers/`, a new "Load Balancers" tab
  in `InfrastructureView.js` (already stubbed as an empty tab per the explore
  findings — this fills it in, doesn't add a new one).
- **Proof**: a real HAProxy process is started on the test node, a real TCP
  connection to the LB's listen port is round-robined to two real running test
  VMs, confirmed by reading which backend answered.

## 3. Kubernetes / container hosting (closes INFRA-ADV-003/004)

**Goal**: let a customer stand up a real, working Kubernetes cluster on their
own provisioned VMs through Inaya — not a new orchestrator. Uses **k3s**
(single static binary, real upstream Kubernetes, not a reimplementation).

- **Mechanism**: new operation types `INSTALL_K3S_SERVER` and
  `INSTALL_K3S_AGENT`, executed by the node agent against instances it already
  created (installs k3s over the instance's existing console/SSH path — no new
  access mechanism). Server install captures the real k3s join token and
  kubeconfig; agent installs join using it.
- **New collection**: `infra_k8s_clusters` (`{k8sClusterId, orgId, vpcId,
  serverInstanceId, agentInstanceIds[], status, kubeconfigSecretRef}`) — the
  kubeconfig itself stored through Inaya's existing secrets-storage path, not a
  new plaintext field.
- **UI**: fills in the existing empty "Containers"-adjacent surface; a
  "Kubernetes" tab showing cluster status and a `kubectl`-compatible
  kubeconfig download (so the customer uses the real `kubectl`, not an
  Inaya-specific tool — consistent with the project's own "wrap real tools,
  don't reimplement them" pattern already set by the Terraform provider).
- **Proof**: a real k3s server + at least one real agent are installed on real
  test VMs created by `QemuKvmProvider`, and `kubectl get nodes` against the
  downloaded kubeconfig genuinely shows both nodes `Ready`, and a real test pod
  is scheduled and reaches `Running`.
- **Container hosting without full k8s**: out of scope as a separate feature —
  the original SOW bundled it with Kubernetes, and k3s is itself a complete
  answer to "run containers on this infrastructure," so a second, parallel
  container-hosting path isn't built.

## 4. TPM-backed identity / confidential computing (closes INFRA-ADV-007/008)

**Goal**: match the GPU precedent exactly — detect and report real hardware
capability honestly, make zero certification or security claim beyond what's
actually verified, same as `detect_gpus()` never claiming passthrough works.

- **TPM presence detection only** — new `detect_tpm()` in
  `inaya-infrastructure/crates/telemetry/src/lib.rs`, checks for a real
  `/dev/tpm0` or `/dev/tpmrm0` and, if present, reads the real TPM version via
  `tpm2_getcap` (from `tpm2-tools`, if installed) — reported as a
  `host_tpm: { present, version }` field in heartbeat capacity, same shape as
  `host_gpu`. If this dev environment has no TPM device, the field reports
  `present: false` truthfully — same honesty bar as the GPU test running
  against a real-but-ordinary laptop GPU.
- **Confidential computing (SEV/TDX) detection only** — new
  `detect_confidential_compute()`, checks real CPU flags
  (`/proc/cpuinfo` for `sev`/`sev_es`/`tdx` on the host, or
  `/sys/firmware/...` where exposed) — reported alongside, never upgraded to an
  "enabled" or "attested" claim unless a real encrypted VM boot is actually
  demonstrated (which, per the GPU precedent, is not attempted here without the
  matching real hardware).
- **Explicitly not built**: TPM-backed node identity/attestation (replacing
  the current ECDSA keypair enrollment with a hardware-rooted one) and actual
  SEV/TDX-encrypted VM execution. Both stay `DEFERRED` in the ledger with the
  same reasoning as today — this SOW only adds honest detection, which is new
  groundwork, not a completed capability.

## Out of scope (unchanged from the original SOW's own deferrals)

- GPU passthrough — excluded this round by direct instruction.
- S3 API compatibility, IAM, Auto Scaling, ELB-API-compatible load balancing.
- Live migration, multi-region fan-out (NATS/JetStream), OVN/OVS networking.
- TPM-backed identity, hardware-attested confidential computing.

## Testing methodology (unchanged house rule)

Every capability above ships with a real-execution test, not a mock — real
HAProxy process, real k3s binary, real signed AWS request, real
`/proc`/`/dev` read — following the exact pattern the existing 39 tests already
use (including the documented `SKIPPED: <reason>` convention for anything that
needs a prerequisite this environment doesn't have, rather than a silent pass).
`scripts/infrastructure/check-duplicate-capabilities.mjs` gets run before
anything is marked `CODED` to catch accidental overlap with what's already
built.
