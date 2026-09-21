# Official Documentation Platform (IBM Cloud Docs-Inspired)

**Status:** Phases 0–3 (and slices of 4, 5, 6, 7) implemented and tested. **Date:** September 2026.

This SOW's own Phase Plan spans 15 phases (0–14) — full CI validation, drift checkers, a Tutorials/Solutions/FAQ engine, Release Notes/Changelog automation, a Contract Reference, an admin/governance interface, and full accessibility/SEO test suites are real, scoped, and genuinely not attempted this pass. This report states exactly what's real today.

## Mandatory Phase 0/1 deliverables

- `docs/audit/documentation-inventory.md` — the full repository audit (existing docs/KB/Learn/RAG/Docs Assistant infrastructure, the API/SDK/CLI surface), produced before any platform code was written.
- `docs/architecture/information-architecture.md` — taxonomy, URL scheme, frontmatter schema, and status model.

## What was built

### The engine (Phase 2)

`content/docs/**/*.md` — a new content directory, deliberately separate from the internal, SOW-report-only `docs/` directory (see the audit for why). `src/lib/docsContent.js` reads it with `gray-matter`, validates every required frontmatter field and rejects a duplicate slug loudly (not a best-effort loader), and derives a table of contents from real markdown headings. `react-markdown` + `remark-gfm` (both already a dependency, already used for the AI chat's own markdown rendering) render content — no new markdown toolchain introduced; `gray-matter` is the one new, small dependency.

### The homepage (Phase 3)

`/docs` — hero, real client-side search, and four cards linking to genuinely working destinations (Product Guides, API Reference, SDK Reference, CLI Reference). No card links to an empty page — Tutorials/Solutions/FAQ, not built this pass, are simply not on the homepage yet rather than linking to nothing, per the SOW's own "No Fake Documentation" rule.

### Search (slice of Phase 4)

A real, small keyword index (`buildSearchIndex()`) over title/description/tags/headings, rendered at `/docs/search` with query-param support (`?q=`). Deliberately not the semantic RAG pipeline — see the Information Architecture doc for why the two stay separate. The existing conversational Docs AI Assistant (`/api/ai/chat` on the main site) is linked from the search page and the homepage as the semantic alternative, unchanged and reused, not rebuilt.

### API Reference (slice of Phase 5)

`/docs/api` + one page per endpoint — all 11 real `/api/public/v1/**` routes, hand-authored directly from the route files (method, params, response shape, a real curl example) since no OpenAPI spec exists anywhere in this repository to generate from. The other ~509 internal routes are deliberately not documented here — they're session-cookie-authenticated internal application API, not a designed third-party integration surface.

### SDK & CLI Reference (Phase 6)

`/docs/sdk` and `/docs/cli` — all 5 published npm packages (`custody-sdk`, `bridge-sdk`, `react`, `inaya-cli`, `create-inaya-dapp`) and the CLI commands across `inaya-cli`, `create-inaya-dapp`, and `node-daemon`, all verified against real `package.json`/README/export content. This closes a real, confirmed gap: `/build`'s existing toolkit section omitted `bridge-sdk` and `node-daemon` entirely.

### Product Guides (slice of Phase 7)

Six real pages: Storage, S3-Compatible Storage, Storage Control Plane & Terraform Provider, Inaya Drive, Business Workspace, Security Layer, plus a Developer Overview. Every claim in them is drawn from this session's own extensive, already-cited audit work — nothing invented, nothing marked live that isn't. The full product taxonomy the SOW sketches (Multi-cloud detail pages, Trust/Evidence, AI, the vertical OS products, Digital Twin) is not migrated yet.

### Reused RAG, real nav entry point

- `src/lib/rag/sources/docsSources.js` gained a new `docs-platform:*` source per `content/docs/**/*.md` file — the exact same shape as the 15 existing `fundraising:*` sources. Verified the chunking logic directly (6 real chunks with correct title/section/url for the Storage Control Plane page); full end-to-end ingestion happens on the next real reingest cycle (`/api/cron/rag-reingest` or `/admin/rag`), consistent with how every other source in that file already works.
- A "Documentation" link was added to the main site's `NAV_GROUPS` (Developers group) — the audit confirmed no "Docs" entry point existed anywhere before this.

## Testing

`test/docs-content.test.mjs` — 9 tests: unique slugs, every required frontmatter field present and every status valid, `getDocBySlug` resolution (including the null case), every `relatedDocs` cross-reference resolves to a real page (no broken internal links), headings genuinely derived from markdown, the search index carries no server-only content leakage, product grouping, and a frontmatter parse smoke test across every real content file. All passing.

`npm run build` — clean, zero errors, every new `/docs` route statically generated (confirmed in the build output: `/docs`, `/docs/api`, `/docs/api/[slug]` × 11, `/docs/sdk`, `/docs/sdk/[slug]` × 3, `/docs/cli`, `/docs/cli/[slug]` × 3, `/docs/products/[slug]` × 6, `/docs/developer/[slug]` × 1, `/docs/search`).

Real browser verification (not just a build check): homepage, a product guide (full markdown rendering including a code block with a working copy button), an API reference detail page, an SDK reference page, and search (query-param prefill, ranked results, a real zero-results state) were all loaded and read back via `get_page_text`/screenshots. Light/dark theme toggle confirmed working (scoped to the `/docs` subtree only, via a `dark` class on a local wrapper — never the document root, so it can't affect any other page on the site). Mobile viewport (375px) tested — found and fixed one real defect (the homepage search button overlapped its own placeholder text at narrow widths) before calling this done.

## What's explicitly not built (see the Information Architecture doc's own "Deferred" section for the full list)

- **Tutorials, Solutions, FAQ-as-a-system, Release Notes, Changelog** — no content exists yet for any of these content types; the schema and renderer support them, nothing fakes their presence.
- **OpenAPI generation and API/SDK/CLI drift checking** — the reference content is hand-authored and accurate today, but nothing detects when the real routes/exports/commands diverge from what's documented. A real, scoped follow-up.
- **Contract Reference, full Multi-cloud/Trust/Evidence/vertical-OS product pages** — not migrated this pass.
- **Full CI validation suite** (link checking, accessibility automation, SEO checks, API/SDK/CLI drift as a build gate), **an admin/governance interface**, **a Documentation Contribution Guide**, and **an API Playground** — none attempted.
- **`docs.inayanetwork.com` subdomain** — ships at `/docs` on the existing deployment instead, which the SOW itself names as an acceptable fallback.
- **Semantic search wired directly into `/docs/search`** — the RAG source exists now, but `/docs/search` itself stays keyword-only; a user who wants semantic answers is directed to the existing chat widget on `/`, not a second chat UI built into `/docs`.
