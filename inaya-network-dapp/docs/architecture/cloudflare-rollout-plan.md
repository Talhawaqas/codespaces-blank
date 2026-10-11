# Cloudflare Integration — Rollout Plan

Phased per the SOW's own gate structure (Audit → Staging edge → Worker → R2 → optional services → Production → Acceptance). Each gate is independently approvable and reversible — no gate assumes the next one will happen.

## Gate A — Audit (this pass, complete)

- `cloudflare-audit.md`, `cloudflare-data-classification.md`, `cloudflare-risk-register.md` (this directory).
- Code fixes that are correct independent of whether Cloudflare is ever deployed:
  - `src/app/api/health/route.js` — new public, DB-free liveness route.
  - `src/app/api/s3/[bucket]/[...key]/route.js` — explicit `Cache-Control: private, no-store` on GET/HEAD (closes the caching gap found in the audit).
- `cloudflare/cache-rules.md` — reviewable Cache Rule spec (not deployed; no Cloudflare account exists in this session).
- `docs/architecture/cloudflare-operator-runbook.md` — the ordered list of operator-only steps for every later gate.

## Gate B — Staging edge, static assets only (operator-executed, next)

Scope: Cloudflare in front of **only** `/downloads/**` and `/_next/static/**` — the two static, non-authenticated, cacheable categories identified in the audit. No dynamic route, no API route, no DNS cutover for MX or any non-static record's proxying behavior changes.

1. Operator creates a Cloudflare account and adds the zone in **DNS-only (grey-cloud) mode** — proxying off for every record initially. This alone changes nothing about traffic; it only lets Cloudflare see the zone.
2. Operator verifies the imported DNS records match the current zone exactly, especially the `support.inayanetwork.com` MX records (risk register #1).
3. Operator enables proxying ("orange-cloud") on the `www`/apex record pointing at Vercel, with the Cache Rule from `cloudflare/cache-rules.md` applied (allowlist: `/downloads/*`, `/_next/static/*` only — default-allow is explicitly forbidden per risk register #5).
4. Verify: desktop installer downloads still work, checksums in `CHECKSUMS.txt` still match, and every authenticated/dynamic route (spot-check a few from each auth mechanism in the audit) still bypasses the cache and reaches the origin untouched.
5. Verify: the two SSE routes and the long-poll route still work end-to-end (a real Meet session, a real Secure Chat session).
6. Verify: a real webhook (e.g. a Stripe test-mode event) still verifies its signature correctly.

## Gate C — Worker (optional, operator-approved, later)

Only if the operator wants Workers for something beyond Cache Rules (e.g. custom edge logic). The Worker skeleton in `cloudflare/worker/` (if scaffolded in this pass) is a starting point, not a deployed artifact — it must be reviewed against the risk register's Worker-specific risk (#7: never trust client-supplied identity headers) before any real deployment.

## Gate D — R2 (optional, not planned in this pass)

Not pursued in this pass. If ever wanted, the correct integration point is a new sibling file in `src/lib/pinningProviders/` (see audit §6's correction) — unrelated to, and independent of, the DNS/edge work above.

## Gate E — Production cutover (operator-only, far later)

Only after Gate B has run successfully in front of real production traffic for a meaningful period with no regressions. Any expansion beyond static assets (e.g. proxying `/api/**`) is a **separate, newly-scoped decision** requiring its own audit-and-plan cycle — not an automatic next step of this plan.

## Gate F — Acceptance

Per the SOW's own Definition-of-Done: confirm every route category in `cloudflare-data-classification.md` behaves as classified (cacheable paths cache, everything else bypasses), confirm the risk register's six risks each have a verified mitigation in place, confirm rollback (disable the Cache Rule, or revert DNS to direct-to-Vercel) has been tested at least once in staging.
