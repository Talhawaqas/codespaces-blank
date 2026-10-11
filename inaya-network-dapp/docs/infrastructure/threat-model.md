# Sovereign Infrastructure Fabric — threat model

Per §205. Threat actors (§205's own list) and the mitigation this architecture actually provides for each, stated honestly — a mitigation not yet implemented/tested is marked so, never implied.

## Security boundaries (§206)

```
Web Control Plane  →  Infrastructure API  →  Gateway  →  Message Fabric  →  Node Agent  →  Hypervisor  →  Guest VM
                                                                                        →  Block Storage
                                                                                        →  Network
                                                                                        →  Identity
```

Each arrow is a trust boundary with its own authentication: session/API-key at the Web→API boundary, mTLS node identity at the Fabric→Node boundary, QEMU process isolation at the Node→Guest boundary.

## Threat actors

1. **Malicious organization member** — mitigated by `requireMembership()`/`canAccessInfrastructure`/`canManageInfrastructure` gates on every org route (existing Inaya pattern, reused as-is), tenant-scoped MongoDB queries, and the AI controlled-execution pipeline (no destructive action bypasses human approval, §112).
2. **Compromised node** — mitigated by per-node mTLS certificates (§41) scoped to only that node's own subjects on the message fabric (NATS subject-level permissions, ADR-003); a compromised node cannot address another node's volumes/instances because ownership is checked server-side, never inferred from the request's claimed identity (§39's "the receiving daemon must not trust org identity solely because it exists in a JSON body").
3. **Compromised admin** — mitigated by the existing audit chain (every privileged mutation is `appendAuditEntry()`'d) and break-glass requirements (§166: time-limited, reason-bound, audited, reviewable) — reusing Inaya's existing break-glass mechanism, not inventing a second one.
4. **Malicious guest VM** — mitigated by QEMU's own process-level isolation (a guest cannot read host memory/another guest's disk by construction of hardware virtualization), QMP restricted to loopback-only and never exposed to the guest or to ordinary API clients (§63), and no guest-controlled command ever reaches a host shell (§61 — structured process arguments only, never string concatenation into a shell command).
5. **Stolen node certificate** — mitigated by certificate revocation (§43: revoke certificate, membership, token, message permission together, evidence recorded) — tested in Phase 1/5 by revoking a node mid-session and confirming it cannot reconnect or execute further commands.
6. **Message-broker attacker** — mitigated by NATS's own TLS+NKey/JWT auth and subject-level ACLs (ADR-003); replay protection via idempotency keys and request IDs on every infrastructure operation (§106, §72).
7. **Network attacker** — mitigated by default-deny network posture (§64: deny unsolicited inbound, deny cross-org, deny host-management traffic, deny unauthorized east-west — only explicit policy-approved traffic allowed), enforced by the nftables security-group implementation (ADR-002).
8. **Physical attacker** (someone with hands on the host) — partially mitigated by host-hardening guidance (§139: minimal OS, SSH hardening, patching, secure boot where available) and `LUKS/dm-crypt` volume encryption where compatible (§188); **not** mitigated against an attacker with full physical/root access to an unencrypted host — stated honestly, not overclaimed, consistent with §154's rule that Inaya's existing Attestation is software-simulated, not hardware-backed, so no TEE/SGX/SEV/TDX protection is claimed in Phase 1.
9. **Supply-chain attacker** — mitigated by the dependency license/version audit (`DEPENDENCY-LICENSE-AUDIT.md`), checksummed/signed release artifacts (§136, §272: SBOM, checksums, signatures, source commit) for the `inaya-infra-node`/`inaya-infra-cli` binaries once a release process exists (Phase 1+, not yet built this pass — binaries are built from source in this environment, not yet distributed as signed releases).
10. **Compromised external dependency** — mitigated by keeping the dependency surface deliberately small and auditable (NATS, a handful of well-known Rust crates — `tokio`, `rustls`, `async-nats`, `serde`), each recorded in the license audit with version pinned; no dependency is added without that audit entry.

## What this threat model does not yet cover (honest gaps, tracked in the implementation ledger)

- A formal red-team pass (§208: forged node, forged org ID, replayed create request, double attach, cross-tenant volume, network isolation bypass, metadata SSRF, cloud-init injection, QEMU argument injection, certificate forgery, message tampering, stale authorization) — scheduled per-phase as each capability is built, not assumed complete from this document alone.
- Chaos testing (§209) against a disposable cluster — scheduled for Phase 5/6 once multi-node infrastructure exists.
- A genuine supply-chain-security release pipeline (signed binaries, reproducible builds) — Phase 1 builds from source only; this is tracked as a gap, not silently dropped.
