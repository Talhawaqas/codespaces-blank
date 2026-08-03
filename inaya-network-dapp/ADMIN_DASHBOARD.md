# Internal Enterprise Dashboard

**Built:** August 3, 2026 (Phase 3 Tier 2). **This is an internal operator tool, not a customer-facing feature.** Do not confuse it with the "My Dashboard" tab inside the main app (`src/app/page.js`), which shows individual customers their own plan status and is completely untouched by this work.

## Where it lives

- **UI:** `/admin` (`src/app/admin/page.js`) — a standalone Next.js page, separate from the main single-page app.
- **API:** `src/app/api/admin/{login,logout,revenue-overview,customers,usage-overview}/route.js`
- **Auth helper:** `src/lib/admin-auth.js`

## How to access it

1. Set `ADMIN_DASHBOARD_PASSPHRASE` in `.env.local` (local) and in Vercel's environment variables (production) — pick your own value, there is no default and the dashboard refuses to authenticate anyone if it's unset.
2. Visit `/admin` and enter the passphrase.
3. Session lasts 12 hours (HttpOnly cookie `inaya_admin_session`, containing a SHA-256 hash of the passphrase — not the raw passphrase itself). Log out clears it early.

There is currently only one shared passphrase for one operator — this was the explicitly scoped "simplest viable option" for a single-operator internal tool. If more than one person needs access with individual accountability, that's a real follow-up (per-admin credentials, not a shared secret) rather than something silently assumed here.

## What it shows

- **Revenue overview:** Corporate Reserve total (by tier), PAYG total, egress total.
- **Customer list:** every Corporate Reserve customer — email, tier, active/expired (computed with the exact same `expiresAt < Date.now()` check as `corporate-plan-status/route.js`, not reimplemented separately), activation date.
- **Usage overview:** total files/bytes stored across every wallet with `metadata_files` records — reuses `custody-sdk`'s `Analytics.getWalletStorageStats()` per wallet rather than re-aggregating with a raw query, so it inherits the same on-chain reconciliation and honest-null behavior Module 2 already built and verified.

## A real schema gap this surfaced

`payg_assets` has **no stored charge amount** — only a `stripeSessionId` reference. PAYG revenue is computed by looking up each session's real `amount_total` live via the Stripe API at request time, not estimated from file size × a rate (which would drift from what was actually charged and violate the standing no-fabricated-numbers rule). This is fast and well within Stripe's rate limits at current data volume (8 records as of this writing); if PAYG volume grows substantially, revisit with caching or — better — start storing the real charged amount in `payg_assets` at checkout time so this dashboard doesn't need N live API calls per page load.

## Honesty behavior

Every total (`corporateReserve.totalUsd`, `payg.totalUsd`, `egress.totalUsd`, `totalBytesStored`) is `null` — never a partial sum, never `0` as a stand-in for "unknown" — if even one underlying record's real value couldn't be confirmed. Each section also reports an `unavailableCount` so a `null` total is explainable, not just a dead end.

## Verified, not just written

- Real requests confirmed `/api/admin/*` genuinely returns 401 with no session cookie, and a wrong passphrase is genuinely rejected — not assumed from reading the code.
- Corporate Reserve's `totalUsd` ($175,500 as of this writing) was manually re-summed from the 10 raw `corporate_plans` records by hand and matched exactly.
- `usage-overview` was checked against the real anchored file from Module 1's E2E test and returned the exact same file count/byte total independently computed there.

## Explicitly out of scope (per the Phase 3 Tier 2 SOW)

- No write actions (refunds, plan changes) — read-only reporting only.
- No changes to the customer-facing "My Dashboard" tab.
- No real-time updates/websockets/polling — loads current data on request.
