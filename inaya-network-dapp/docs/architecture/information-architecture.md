# Official Documentation Platform — Information Architecture

Phase 1 deliverable, built directly on the Phase 0 audit (`docs/audit/documentation-inventory.md`). Defines taxonomy, content types, URL scheme, frontmatter schema, and statuses for the new `/docs` platform.

## Why a new `content/docs/` directory, not the existing `docs/`

The root `docs/` directory is confirmed internal-only (22+ SOW/architecture/audit reports, none RAG-ingested, none public). Reusing it for public platform content would either contaminate an internal engineering archive with public copy, or require moving 20+ existing internal files — out of scope and unnecessary. This SOW's real, public source content lives in a new **`content/docs/`** directory at the repo root, parallel to `src/`, `public/`, and `docs/`. `public/docs/business-workspace-guide.md` (the one pre-existing real public doc) is left exactly where it is — it's still served at its existing raw URL and still RAG-ingested from there — rather than moved and risking a broken existing link.

## URL scheme

```
/docs                          — homepage
/docs/search                   — search results
/docs/products/<slug>          — Product Guides (Storage, Business Workspace, Security, Multi-Cloud, ...)
/docs/developer                — Developer Hub index
/docs/developer/<slug>         — developer concept/how-to pages
/docs/api                      — API Reference index
/docs/api/<slug>                — one public/v1 endpoint
/docs/sdk                      — SDK Reference index
/docs/sdk/<package>              — one npm package's reference
/docs/cli                      — CLI Reference index
/docs/cli/<command>              — one CLI tool's command reference
```

Every content page is addressed by a stable slug read from its markdown file's frontmatter or its position in `content/docs/`, so pages can be moved without breaking the URL (the loader keys on `slug`, not file path).

## Content types (implemented this pass)

`Product Guide`, `Concept`, `How-To`, `API Reference`, `SDK Reference`, `CLI Reference`. The renderer hides any frontmatter-declared section that has no content, per the SOW's own instruction — it never renders an empty "Troubleshooting" or "Limits" heading just because the schema has a slot for one.

**Not implemented this pass** (schema has room for them; no content exists yet): `Tutorial`, `Quickstart`, `FAQ`, `Solution`, `Architecture`, `Security`, `Trust`, `Integration`, `Migration`, `Troubleshooting`, `Release Notes`, `Changelog`, `Reference`, `Limits`, `Error Reference`, `Glossary`.

## Frontmatter schema

Required fields (validated at build time — a missing required field or a duplicate slug fails the content loader loudly rather than silently rendering a broken page):

```yaml
---
slug: s3-compatible-storage
title: S3-Compatible Storage
description: Use Inaya through an S3-compatible API — real AWS SigV4 request signing against your own organization's storage.
product: Storage
category: guide
contentType: Product Guide
audience: [developer, enterprise-it]
status: live
version: current
tags: [s3, storage, aws]
lastVerifiedAt: "2026-09-21"
---
```

Optional fields, supported by the loader and rendered as a `StatusBadge`/`VersionBadge` when present: `deprecatedAt`, `replacement`, `experimental`, `testnetOnly`, `requiresAuthentication`, `requiresAdmin`, `requiresEnterprisePlan`.

`relatedDocs` is expressed as a frontmatter array of slugs (`relatedDocs: [inaya-drive, multi-cloud-storage]`), resolved and rendered by the `RelatedDocs` component — this is the SOW's own "explicit relationships first" rule (§50); no semantic-similarity recommendation engine was built.

## Status values

`live`, `testnet`, `beta`, `planned`, `deprecated` — a strict subset of the SOW's full badge list (§66), scoped to what this pass's actual content needs. Every page in `content/docs/` created this pass is `live`, verified against this session's own extensive, already-cited audit work — nothing is published as live that isn't. Digital Twin cross-organization simulation, wherever mentioned, is explicitly labeled `planned`.

## Reused, not rebuilt

- **Search:** a real client-side keyword index over `content/docs/**` titles/descriptions/headings (new, small, genuine gap per the audit). Semantic/conversational search stays on the existing `/api/ai/chat` RAG pipeline via an "Ask Inaya" link — `content/docs/**/*.md` is added as a new source to `src/lib/rag/sources/docsSources.js`, the same shape as the 15 existing `fundraising:*` sources.
- **Rendering:** `react-markdown` + `remark-gfm`, both already a dependency (used today for the AI chat's own markdown rendering) — no new markdown toolchain introduced. `gray-matter` is the one new, small dependency added, for frontmatter parsing.
- **Deployment:** the existing Next.js/Vercel setup, unchanged.

## Deferred (see the completion report for the full list)

OpenAPI generation/drift checking, a Tutorials/Solutions/FAQ system, Release Notes/Changelog automation, a Contract Reference page, full CI validation scripts, an accessibility/SEO automated test suite, an admin/governance interface, and a Documentation Contribution Guide are all genuine, currently-real gaps this pass does not close — consistent with the SOW's own explicit phased Plan (Phases 4–14), which anticipates this spanning more than one implementation pass.
