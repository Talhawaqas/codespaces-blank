# Official Documentation Platform — Phase 0 Audit

**SOW:** Inaya Official Documentation Platform (IBM Cloud Docs-Inspired). **Status:** Mandatory pre-implementation audit, completed before any platform code was written, per the SOW's own governing rule (AUDIT → REUSE → ORGANIZE → IMPLEMENT ONLY GENUINE GAPS → TEST → SECURE → VERIFY → PUBLISH).

## CURRENT DOCUMENTATION

- **No `/docs`, `/help`, `/kb`, or `/knowledge-base` route exists anywhere under `src/app/`.** Confirmed by a repo-wide directory search.
- **No MDX file exists anywhere in the repo.**
- **One real, public, RAG-ingested markdown document exists:** `public/docs/business-workspace-guide.md`, served raw at `/docs/business-workspace-guide.md`. This is the strongest existing precedent for format/tone.
- **`public/documents/` holds 19 generated PDFs** (whitepaper, FAQs, ecosystem overview/architecture/dev-deepdive, pilot guides, SDK guide, etc.), produced by two script pipelines (`scripts/fundraising-docs/`, `scripts/pilot-guides/`), each with real structured JS content sources. These are marketing/investor collateral, not a browsable documentation product.
- **The root `docs/` directory (22 files, now 24 with this SOW's own two new files) is internal-only.** Every file sampled self-identifies as an internal SOW/architecture/audit report (e.g. "Internal architecture doc for the SOW..."). None of it is public documentation and none of it is RAG-ingested. It stays exactly as-is — this SOW's own new content lives in a separate, new `content/docs/` directory (see the Information Architecture doc) specifically so it never gets confused with these internal reports.
- **Two existing root-level markdown files are strong content-migration candidates** (real, user-facing, not internal): `CROSS_CHAIN_BRIDGE_GUIDE.md` and `INAYA_ECOSYSTEM_FEATURES_AND_BENEFITS.md`.
- **A "Updates & Knowledge Base" drawer exists in `src/app/page.js`** (`isUpdatesDrawerOpen`) but is, by its own in-code comment, a marketing/changelog surface rendering a ~1,950-line blog-style `KNOWLEDGE_ARTICLES` constant — not a documentation portal despite the name, and explicitly kept separate from it.

## CURRENT PRODUCTS

Verified real, shipped product surfaces this platform's Product Guides section should cover (cross-referenced against this session's own extensive prior audits, `src/lib/saasRoadmap.js`, and the two research passes above): Storage (client-side encryption/sharding/custody, S3/Azure/GCS compatibility, Inaya Drive, Storage Control Plane, snapshots, backup policies), Business Workspace (organizations/departments/documents/permissions/Tasks/CRM/Procurement/Inventory/Finance/HR/Sign/Escrow/Data Room/Insights/Evidence Graph/Digital Twin), Security Layer (threat registry, node reputation, public API), the AI layer (Docs/Business/Security/Learn assistants, all grounded by one shared RAG pipeline), the Developer Platform (5 published npm packages), Multi-chain (bridge/staking across 8 verified testnets), and the vertical OS products (Health/Legal/Financial/Regulated/Government). Digital Twin cross-organization simulation was researched and deliberately deferred — documented as **Planned/Proposed**, not live.

## CURRENT APIs

- **Public, third-party-integration-designed surface: 11 routes under `src/app/api/public/v1/**`**, 100% consistently authenticated via `requireApiKey()` (bearer API key, resolves a synthetic owner-level membership scoped to exactly one org — never overridable by the request). Covers evidence lookup, audit-chain verification, permission-gate checks, and the storage control plane (resources/snapshots/backup-policies/backup-plans) added this session for `terraform-provider-inaya`.
- **520 total `route.js` files** under `src/app/api/`. The other ~509 are session-cookie-authenticated internal application routes (`orgs/` alone is 328 routes — the Business Workspace's own API), admin-passphrase-gated (`admin/`, 29 routes), or cron-secret-gated (`cron/` plus scattered `*/cron/*` routes, 15 total). These are **not** documented as a public reference surface in this pass, except where a published package already depends on one (e.g. `node-daemon` calling `nodes/operator/*`, `nodes/register`, `nodes/heartbeat` — noted in the SDK reference as "the routes this package calls," not published as a standalone public API).
- **No OpenAPI/Swagger specification exists anywhere in the repository**, and no code generates one. This platform's v1 API reference is hand-authored directly from the 11 public/v1 route files, not auto-generated — Phase 16/76's source-automation goal (source → schema → renderer, avoiding a second manually-copied reference) is recorded as a real, deferred follow-up, not attempted this pass.

## CURRENT SDKs

Five packages published to the public npm registry, confirmed live (not merely built) earlier this session via `npm view`: `@inaya-network/custody-sdk` (the core crypto/on-chain/payments/metadata/analytics/backup SDK `/build` already documents), `@inaya-network/bridge-sdk` v0.1.0 (`InayaBridgeClient`, `CHAIN_IDS`, `SOLANA_DEVNET_CHAIN_ID`), `@inaya-network/react` v0.1.0 (`InayaConnect`, `InayaUploader`, `InayaFileBrowser`), `inaya-cli` v0.1.0 (`inaya login|upload|list|deploy`), `create-inaya-dapp` v0.2.0 (`npx create-inaya-dapp <name> [--template]`). All five have real `package.json` metadata, a README, and inspectable exports — genuine reference material, not invented.

## CURRENT CLI

`@inaya-network/node-daemon` v0.1.0 adds a sixth real CLI surface (`inaya-node-daemon login|register|start|report|status|service install|service uninstall`) not currently documented anywhere on the live site — `/build`'s toolkit section covers only 4 of these 5 installable packages today (omits `bridge-sdk` and `node-daemon` entirely). This is a genuine, confirmed gap this platform closes.

## CURRENT CONTRACTS

Not independently re-audited in this pass — this SOW's API/SDK/CLI reference sections do not require re-verifying on-chain contract addresses, and `src/lib/saasRoadmap.js`'s existing Stage 12/13 entries plus `page.js`'s own Phase 3 roadmap list already carry verified chain/contract status. A dedicated Contract Reference page (SOW §19) is deferred to a later pass — see "Not Built."

## CURRENT KNOWLEDGE BASE

`src/lib/inaya-knowledge.js`'s `INAYA_KNOWLEDGE_BASE` constant (171 lines) is chunked and RAG-indexed as source `inaya-knowledge-base`, but is not itself a browsable page anywhere — it exists only as retrieval material for the Docs AI Assistant. Not migrated into the new `content/docs/` tree in this pass (its content overlaps substantially with what this SOW's own new product-guide pages cover more accurately); left as a live RAG source, unchanged.

## CURRENT LEARN

`src/components/learn/LearnSection.js` + `src/lib/learnConfig.js` — a YouTube-video discovery/bookmark layer (11 categories, curated collections/paths of search queries), not an authored curriculum, with its own AI tutor (`/api/ai/learn-chat`). Real and live, but explicitly out of scope for this documentation platform (it's a distinct product surface, cross-linked only).

## CURRENT RAG

A real, tested, production RAG pipeline (`src/lib/rag/`) already exists: MongoDB Atlas hybrid search (native Vector Search + Atlas Search, merged via application-level Reciprocal Rank Fusion) over Gemini `gemini-embedding-001` embeddings, with a `DEFAULT_MIN_RELEVANCE = 0.80` threshold, prompt-injection sanitization on every retrieved chunk (`sanitize.js`), and a structural guarantee (enforced by a static code scan in `test/rag-security.test.mjs`) that private collections are never embedded. Nightly reingestion cron (`/api/cron/rag-reingest`) plus an admin monitoring surface (`/admin/rag`). **This platform reuses this pipeline unchanged** — the only new work is adding `content/docs/**/*.md` as a new source in `src/lib/rag/sources/docsSources.js`, exactly the same shape as the 15 existing `fundraising:*` sources.

## CURRENT DOC ASSISTANT

`POST /api/ai/chat`, grounded via `retrieveContext({domain:'docs'})` against `docsSources.js`'s current source list (the internal knowledge-base constant, the one existing public markdown guide, the FAQ page, and the 15 fundraising-docs content files — confirmed by direct read, not the internal `docs/` SOW-report directory). Its UI today is a floating chat bubble embedded directly in `src/app/page.js`, present only on `/`, not site-wide. This platform adds the new content as a fourth kind of source and links to this same assistant from documentation pages, rather than building a second AI stack.

## CURRENT SEARCH

No search of any kind exists for documentation today (the floating chat is conversational, not a search index; there's no keyword/full-text search anywhere in the app for this class of content). This is a genuine gap this platform fills with a lightweight, real client-side index (title/description/heading match) over the new content — not the semantic RAG layer, which remains reserved for the "Ask Inaya" conversational entry point per the SOW's own Phase 4 instruction to reuse existing RAG "where it supports" semantic search rather than force every search interaction through it.

## CURRENT DEPLOYMENT

Reuses the existing Next.js/Vercel deployment as-is (`vercel.json` already exists with cron entries) — no new deployment target introduced. The SOW's preferred `docs.inayanetwork.com` subdomain is not provisioned in this pass (DNS/domain configuration is outside this repository's scope); the platform ships at `/docs` on the existing site, which the SOW itself names as the acceptable fallback ("or an equivalent official `/docs` path... after repository and deployment audit").

## CURRENT DOCUMENTATION GAPS

Everything this SOW's own Phase Plan schedules for Phases 4 (semantic search wiring), 5 (drift-checked API reference), 8 (tutorials/solutions), 9 (release notes/changelog), 12 (full validation/CI/accessibility suites), and 14 (governance) that is not listed as delivered in this pass's completion report is a genuine, currently-real gap — not attempted, not faked. See that report for the exact line drawn in this pass.
