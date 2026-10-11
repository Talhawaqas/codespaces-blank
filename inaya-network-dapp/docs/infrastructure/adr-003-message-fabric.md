# ADR-003: Message fabric — NATS + JetStream

Status: Accepted, 2026-10-10.

## Context

§37/§299 ask for an evaluated choice before NATS becomes a committed dependency. The fabric carries: control-plane → node commands (`inaya.compute.create`, `inaya.block.attach`, ...), node → control-plane telemetry (`inaya.node.heartbeat`, `inaya.node.capacity`), and audit events (`inaya.audit.event`).

## Evaluation (§299's checklist)

- **Clustering**: NATS clusters natively (gossip-based), which matters for Phase 5's 3-node test and beyond.
- **JetStream**: gives durable, at-least-once delivery for commands that must survive a broker restart (e.g. a queued VM-terminate request), while plain NATS pub/sub covers ephemeral request/reply (heartbeats, capacity reports) without the durability overhead — matches §37's own distinction ("durable messaging where the operation needs durable delivery and ephemeral request/reply where appropriate").
- **Authentication**: NATS supports TLS mutual auth and NKey/JWT-based per-client identity — fits the mTLS node-identity model (§41) directly, no bolt-on needed.
- **Offline behavior**: a node's local JetStream consumer can keep working against a local or last-known broker state during a WAN partition, which is exactly the offline/edge model (§52-56) this SOW needs; this is evaluated for real in Phase 6, not assumed here.
- **Operational complexity**: a single NATS server binary (or a small JetStream-enabled cluster) with no external dependencies — low operational weight relative to alternatives (Kafka is far heavier for this traffic profile; plain gRPC streams would mean reinventing pub/sub, durability, and clustering by hand).
- **License**: Apache-2.0 (confirmed, recorded in `DEPENDENCY-LICENSE-AUDIT.md`) — no AGPL/commercial-license concern, unlike Spinifex itself.
- **Security**: NATS's auth model (TLS + NKeys/JWT + subject-level permissions) lets a compromised node's credentials be scoped to only the subjects that node legitimately needs (§40 — "it must not have... another organization's API key"), enforced by the broker itself, not just application-level discipline.

## Decision

NATS + JetStream, run as a container (confirmed: WSL2's Docker daemon is live and reachable from this session) for development/testing, with a documented path to a dedicated NATS cluster for production multi-node deployments.

## Consequences

- `inaya-infrastructure/crates/messages` wraps `async-nats` (the official Rust client) with Inaya's own subject-naming module (§38) and message-metadata envelope (§39: `orgId`, `actorIdentityId`, `requestId`, `traceId`, `clusterId`, `resourceId`, `policyVersion`, `timestamp` on every message) — the receiving daemon never trusts org identity solely because it's present in a JSON body (§39's own rule), it's independently verified against the sender's mTLS-authenticated node identity.
- Subject naming follows §38's suggested tree (`inaya.compute.*`, `inaya.block.*`, `inaya.network.*`, `inaya.node.*`, `inaya.audit.event`), finalized and documented as implementation proceeds (§38's own "final subject naming is implementation-owned and must be documented").
- NATS is a genuine new third-party runtime dependency — recorded in `DEPENDENCY-LICENSE-AUDIT.md` as required by §8/§204.
