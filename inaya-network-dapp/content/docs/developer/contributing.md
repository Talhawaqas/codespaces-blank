---
slug: contributing
title: Contributing to This Documentation
description: How this documentation platform actually works — content structure, frontmatter, local preview, and what review process exists today.
product: Developer Platform
category: how-to
contentType: How-To
audience: [developer, community-contributor]
status: live
version: current
tags: [contributing, documentation, markdown]
lastVerifiedAt: "2026-09-22"
relatedDocs: [developer-overview]
---

## Where the content lives

Every page under `/docs/products/*` and `/docs/developer/*` is a real markdown file in `content/docs/**/*.md`, with YAML frontmatter. This is a plain content directory read at request time by `src/lib/docsContent.js` — no CMS, no database.

`/docs/api`, `/docs/sdk`, and `/docs/cli` are different: they render from hand-authored structured data (`src/lib/docsApiReference.js`, `docsSdkReference.js`, `docsCliReference.js`), not markdown, because their content is tabular (parameters, exports, commands) rather than prose.

## Adding or editing a Product Guide or Developer page

1. Create or edit a `.md` file under `content/docs/products/` or `content/docs/developer/`.
2. Fill in the required frontmatter fields:

```yaml
---
slug: my-new-page
title: My New Page
description: One sentence, shown on cards and in search results.
product: Storage
category: guide
contentType: Product Guide
audience: [developer]
status: live
version: current
tags: [example]
lastVerifiedAt: "2026-09-22"
relatedDocs: [storage]
---
```

3. Write the body in plain markdown, using `##`/`###` headings — the table of contents and section anchors are generated automatically from them, never hand-maintained separately.
4. Run `npm run dev` and open `http://localhost:3000/docs/products/my-new-page` (or `/docs/developer/...`) to preview.

## What gets validated, and when

`src/lib/docsContent.js`'s loader throws immediately — at page render time, not silently — if a required frontmatter field is missing, `status` isn't one of `live`/`testnet`/`beta`/`planned`/`deprecated`, or a slug is duplicated. `test/docs-content.test.mjs` runs the same checks as an automated test, plus a check that every `relatedDocs` entry actually resolves to a real page (no broken internal cross-references).

## The honesty rule

Every page must state plainly what's real, what's testnet-only, and what's deferred — the same discipline every other document on this platform follows (see `docs/audit/documentation-inventory.md` and `docs/architecture/information-architecture.md`). Never mark something `live` that isn't shipped and working.

## What review process exists today

Honestly: there is no formal CI gate, external review workflow, or public pull-request process for this documentation yet — this is a genuine, disclosed limitation, not an oversight. Content changes go through the same commit/push flow as the rest of this codebase. A real CI validation pipeline (frontmatter/link checking wired into a build gate) is a documented, deferred follow-up — see `docs/official-documentation-platform-report.md`.

## Related

- [Developer Overview](/docs/developer/developer-overview)
