# Fundraising document generator

Generates the investor-facing PDFs published at `/documents/*.pdf`:

- `content/executive-summary.js` → `public/documents/inaya-executive-summary.pdf`
- `content/investment-memorandum.js` → `public/documents/inaya-investment-memorandum.pdf`

## Why this exists

As of August 2026, these PDFs had **no tracked source anywhere in the
repo** — they were authored outside the project (Google Docs / Gemini) and
committed as finished binaries, with every later update just swapping the
binary at the same path. That made them impossible to diff, review, or
edit safely. This generator gives them a real, versioned source of truth:
edit the content files below, regenerate, done.

The GTM Strategy (`inaya-gtm-strategy.pdf`) isn't wired up yet — it's a
93-page/35-section document undergoing a separate outline-and-sign-off
pass before full content is written. When that's ready, it follows the
same pattern: a `content/gtm-strategy.js` file plus a page template in
`template.js`.

## Editing content

Open `content/executive-summary.js` or `content/investment-memorandum.js`
directly — they're plain JS objects (heading/body/bullets/etc.), not HTML.
**Read the header comment in `investment-memorandum.js` first** — several
sections are marked PROTECTED and shouldn't be edited without explicit
founder sign-off (mainnet-readiness language, financial projections, the
funding ask).

## Regenerating the PDFs

```bash
cd inaya-network-dapp
node scripts/fundraising-docs/generate.mjs
```

Requires a system-installed Chrome or Edge (used headless via
`puppeteer-core` — no bundled Chromium download). It checks the default
Windows/Linux install paths automatically; if yours is somewhere else, set
`CHROME_PATH`:

```bash
CHROME_PATH="/path/to/chrome" node scripts/fundraising-docs/generate.mjs
```

This overwrites the PDFs directly in `public/documents/`. Review the diff
(`git status` / open the PDFs) before committing.

## Changing the look

All visual styling lives in `brand.css` (shared by every generated
document) and the layout logic in `template.js`. The Executive Summary
uses a `.page-compact` variant to keep everything on one physical page —
if you add content there, check the page count after regenerating
(`pdftotext yourfile.pdf - | grep -c $'\f'` should print `1`).
