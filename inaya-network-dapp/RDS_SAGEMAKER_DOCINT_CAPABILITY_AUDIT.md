# RDS + SageMaker + Document Intelligence Gap Expansion — Phase 0 Capability Audit

Mandatory audit per the SOW's own Section 8, done before any implementation. Findings are cited to real files. Classification taxonomy follows the SOW's Section 2.

## 1. Deployment environment (the fact that gates everything else)

Inaya's application (`inaya-network-dapp`) is a Next.js app deployed to **Vercel serverless functions** (confirmed: `vercel.json` cron entries, per-route `maxDuration` limits, no Dockerfile for this app, no VM/container orchestration anywhere in this repo or its sibling repos). Its only persistent data store is **MongoDB Atlas** (remote, managed). There is no process on this stack that stays running between requests, no container runtime, no VM layer, and no GPU/training compute.

This means, as a plain fact and not a judgment call:

- **A literal "Inaya hosts and runs a PostgreSQL server process" is not possible on the current infrastructure.** A serverless function cannot bind a listening TCP port that survives between invocations, so there is nothing for Postgres's own connection protocol to attach to.
- **Arbitrary notebook code execution has no sandbox to run in.** There is no isolated compute environment (container, microVM, gVisor, Firecracker, etc.) anywhere in this codebase or its infrastructure. Building one is itself a multi-week infrastructure project, not an application feature.
- **Real model training** (fitting weights on data, not calling a hosted inference API) has the same problem: no long-running, resource-isolated compute exists to run it on.

This is exactly the class of finding the SOW's Section 2 calls **REQUIRES ARCHITECTURAL DECISION**, and Section 14.2 / 10.9 both require that "if secure notebook execution cannot be implemented safely in the current environment, document it as an infrastructure dependency rather than delivering an unsafe pseudo-notebook." The same standard applies to hosting a real database engine and to real training compute.

## 2. Database layer — existing evidence

| Item | Found | Classification |
|---|---|---|
| Mongo client / connection pooling | `src/lib/mongodb.js` — a single shared `MongoClient`, connect-once pattern | ALREADY IMPLEMENTED (Mongo only) |
| Relational connector framework | `src/lib/legacyDataAccess/connectorRegistry.js`, `connectors/relational.js` — a real, tested `node:sqlite` connector with `isConfigured/testConnection/discoverMetadata/executeQuery/health/capabilities` | ALREADY IMPLEMENTED (read-only, SQLite reference engine, from the Mainframe & Legacy Data Access SOW) |
| SQL gateway (parse, authorize, execute, audit) | `src/lib/legacyDataAccess/sqlGateway.js` — real SQL AST parser, authorization against published tables, row/timeout limits, audit | ALREADY IMPLEMENTED, but **read-only** and scoped to querying an already-existing external/reference source, not to provisioning or writing to a new managed database |
| Encrypted credential storage for a data source | `src/lib/legacyDataAccess/credentials.js` | ALREADY IMPLEMENTED — directly reusable pattern |
| Managed PostgreSQL/MySQL/etc. hosting, provisioning, lifecycle | No `pg`, `mysql2`, `mssql`, `knex`, `sequelize`, `prisma` dependency anywhere in `package.json`; no provisioning code; no engine process management | GENUINE GAP, but **blocked on the architectural decision in §1** — there is no compute to host an engine on |
| DB backup/snapshot/PITR, Multi-AZ, failover, read replicas, connection proxy | None found | GENUINE GAP, same blocker |
| DB TLS/at-rest encryption/secrets rotation for a hosted engine | None found (object-storage encryption exists — `s3-compat/*`, `documentAutomation` — but that is a different trust boundary per the SOW's own §7.6) | GENUINE GAP, same blocker |

**Conclusion for Workstream A:** the write-capable pieces of "RDS-like managed relational database service" (provisioning, hosting, HA, replicas, proxy, PITR against a live engine) cannot be built honestly without first deciding **where the engine actually runs** — see §5, Decision 1.

## 3. AI/ML Studio layer — existing evidence

| Item | Found | Classification |
|---|---|---|
| AI provider abstraction, gateway, policy, guardrails | `src/lib/aiSecurity/*` (from the AI Security Workflow SOW): `promptInjection.js`, `piiDetector.js`, `policyEngine.js`, `orgPolicy.js`, `modelRegistry.js`, `gateway.js` | ALREADY IMPLEMENTED — directly reusable for Studio governance; `modelRegistry.js` already tracks configured AI components |
| RAG / embeddings / vector search / retrieval analytics | `src/lib/rag/*` | ALREADY IMPLEMENTED — reuse, do not duplicate |
| Cron/workflow job orchestration | `src/lib/workflows/*`, `vercel.json` crons | ALREADY IMPLEMENTED — the SOW itself (§10.8) says reuse this instead of a second scheduler |
| Data catalog (general, spanning datasets/tables/models/analyzers) | Only narrow, feature-specific metadata exists (docs content index, KB); no general asset catalog | GENUINE GAP — buildable now, no new infra needed |
| SQL Query Editor over a real relational source | The SQL gateway exists (read-only, external sources); no editor UI | PARTIAL — buildable now over the *existing* read-only gateway; cannot be a general Studio SQL surface until Workstream A resolves |
| Data quality rules engine | None found as a first-class service | GENUINE GAP — buildable now (pure logic over existing Mongo/relational sources) |
| Visual ETL / pipeline builder | Workflow engine's node canvas (`src/lib/workflows/nodes.js`) is the closest existing primitive | PARTIAL — extend the existing engine rather than building a second one, per SOW §10.8 |
| Notebook execution | None found; no sandbox infra (§1) | GENUINE GAP, blocked on architectural decision — see §5, Decision 2 |
| Real model training | None found; no training compute (§1) | GENUINE GAP, blocked on architectural decision — see §5, Decision 2 |
| Model registry / versioning / evaluation / artifact integrity | None found as a dedicated service (bookkeeper/document-automation have their own narrow versioning, not general-purpose) | GENUINE GAP — buildable now: this is metadata plus storage plus hashing, not new compute |
| Model deployment endpoints (real-time/async/batch/serverless inference hosted by Inaya) | No self-hosted inference infra; Inaya only ever calls out to an existing AI provider (Gemini) | GENUINE GAP, blocked on architectural decision — Inaya has no compute to serve a model from; an "endpoint" here can only ever be a governed wrapper around calling an already-hosted provider (Decision 2 covers this) |
| Lineage | `businessEvents.js` / Evidence Graph exists generally; no OpenLineage-shaped ML lineage | PARTIAL — extend Evidence Graph, do not build a second lineage store |

**Conclusion for Workstream B:** the catalog, data-quality, lineage, model-registry-as-metadata, and governance pieces are real, buildable gaps with no new infrastructure risk. Notebooks, real training, and real self-hosted inference endpoints are blocked on the same compute question as Workstream A.

## 4. Document Intelligence layer — existing evidence

| Item | Found | Classification |
|---|---|---|
| PDF text extraction | `unpdf` dependency, used in `src/lib/bookkeeper/extract.js` for deterministic text-PDF extraction with line/snippet provenance, and in `src/lib/documentAutomation/*` for the generated-document side | ALREADY IMPLEMENTED for **text PDFs** |
| Deterministic field extraction with provenance, arithmetic validation | `src/lib/bookkeeper/extract.js` (`findLabeled`, `validateExtraction`) — the closest real precedent for "confidence + grounding" in this codebase | ALREADY IMPLEMENTED, narrowly (invoices/receipts/bills only) — the pattern is exactly right to generalize, not to rebuild |
| Local OCR engine (image / scanned-PDF text extraction) | None. Confirmed: no `tesseract`, no image-OCR dependency anywhere in `package.json`. The bookkeeper's own docs state plainly: "no local OCR engine... never auto-processed" | GENUINE GAP — but this is an **EXTERNAL DEPENDENCY** (a real OCR engine or a vision-capable AI model call), not a hosting/compute blocker; it is buildable today by calling the existing AI gateway for image input, same seam the bookkeeper already uses |
| Malware/file-safety scanning | `scanBuffer` (existing scanner, reused by bookkeeper, customer portal, support attachments) | ALREADY IMPLEMENTED — reuse directly |
| Analyzer registry, versioning, schema, classification, segmentation, confidence/grounding as a first-class, general (not invoice-only) service | None found | GENUINE GAP — buildable now, no new infra: this is Mongo documents, the AI gateway, and `unpdf`, all of which already exist |
| Human review queue for low-confidence extraction | `src/lib/bookkeeper/review.js` and `src/lib/documentAutomation` both have narrow, working precedents (10 review actions in the bookkeeper) | PARTIAL — generalize the existing pattern, do not build a second review engine |
| Evidence Graph subject types for extraction provenance | `businessEvents.js` already has `BOOKKEEPING_DOCUMENT`, `GENERATED_DOCUMENT` subjects with a documented one-line extension point | ALREADY IMPLEMENTED as a pattern — add a new subject type the same way |

**Conclusion for Workstream C:** this is the one workstream with **no architectural blocker**. Every primitive it needs (PDF text extraction, the AI gateway for vision/OCR fallback, encrypted storage, malware scanning, review queues, Evidence Graph, audit) already exists and has at least one working precedent in this exact codebase. It can be built as a genuine, tested, general-purpose Document Intelligence Studio without any new hosting decision.

## 5. Architectural decisions this audit surfaces (per SOW §2 "REQUIRES ARCHITECTURAL DECISION")

**Decision 1 — Workstream A (Relational Database Service).** Real managed-Postgres semantics (a live, connectable, writable database instance with backups/PITR/HA) cannot run on Vercel serverless. The only honest way to deliver this is for Inaya's control plane to provision and manage a database on a **real external provider that exposes a management API** (for example a managed Postgres provider reachable over HTTPS), using the exact same "provider adapter, never assume one vendor" pattern already proven by `pinningProviders/*` and `legacyDataAccess/connectorRegistry.js`. This needs a provider account and its credentials before any "genuine gap" in §9 can be implemented for real, rather than mocked. Building the control-plane data model, API, UI and governance layer can proceed now; provisioning a real engine cannot be verified until that account exists.

**Decision 2 — Workstream B (notebooks, real training, self-hosted inference endpoints).** These need either (a) a real sandboxed compute provider (again, an external service reachable over an API, not code running inside this Vercel function), or (b) an explicit decision to not build literal code execution / training / hosted inference, and instead build the **governance layer only** — catalog, lineage, model registry as metadata, evaluation records, and an "endpoint" that is honestly a permissioned wrapper around the existing AI provider call, never a claim of self-hosted serving. Per the SOW's own repeated instruction ("do not deliver an unsafe pseudo-notebook", "do not claim managed ML training if the platform only launches a Python script on the same web server"), building a fake notebook or fake training job would violate the SOW itself.

Neither decision blocks Workstream C, and neither blocks the governance/catalog/lineage/registry portions of Workstream B.

## 6. Recommendation carried into the plan

Build in this order, matching the SOW's own §33 release strategy and this audit's findings:

1. **Workstream C (Document Intelligence Studio)** — fully buildable now, real engines, real tests, no external account needed beyond what already exists (the AI gateway).
2. **Workstream B, governance-only slice** (catalog, data quality, lineage extension, model registry as metadata, evaluation records, SQL editor over the existing read-only gateway) — fully buildable now.
3. **Workstream A and the remainder of Workstream B (real engine hosting, notebooks, real training, self-hosted endpoints)** — held pending Decision 1 / Decision 2 above. Documented honestly as `HARDWARE / INFRASTRUCTURE REQUIRED` per the SOW's own mandatory status labels (§27) until a provider is chosen and credentials exist.
