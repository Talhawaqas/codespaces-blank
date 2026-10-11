# Cloudflare Integration — Operator Runbook

Every step below requires a real Cloudflare account, real DNS access, and/or a real production traffic decision — none of this was performed or can be performed from this environment. Each step is individually confirmable; none should be batched or assumed pre-approved by an earlier one. This exists specifically because the SOW itself repeats "stop and ask the operator" throughout, and because production DNS/infrastructure changes are outside what should ever be done unilaterally.

## Prerequisite reading

Read `cloudflare-audit.md`, `cloudflare-data-classification.md`, and `cloudflare-risk-register.md` in this directory first — they're the factual basis for every step below.

## Step 1 — Create the Cloudflare account and zone (no traffic impact)

- Create (or use an existing) Cloudflare account.
- Add `inayanetwork.com` as a zone, in **DNS-only mode** (grey-cloud) for every record. This step alone does not change where traffic goes.

## Step 2 — Export and verify existing DNS records (no traffic impact)

- Export the full current zone from the current registrar/DNS host before touching anything.
- In Cloudflare's DNS tab, confirm every existing record was imported correctly against the **verified 2026-10-11 baseline** (see `cloudflare-risk-register.md` risk #1 — 16 records total: 2 A, 6 CNAME, 3 MX, 5 TXT), with special attention to:
  - The `pilot` subdomain `A` record (76.76.21.21) — **confirmed missed by Cloudflare's automated scan once already**; add it manually if it's not there.
  - The apex and `www` records pointing at Vercel (76.76.21.21 / `cname.vercel-dns.com`).
  - The Hostinger mail MX/DKIM/autoconfig/autodiscover records and the Resend outbound-sending (`send` subdomain) MX/SPF/DKIM records.
  - Any other verification (SPF/DMARC/Google-site-verification) TXT records.
- There is no `support.inayanetwork.com` record to worry about — that inbound-email setup was never completed at the DNS level (corrected from an earlier, stale assumption).

## Step 3 — Point nameservers at Cloudflare (traffic-affecting; low risk if Step 2 passed)

- Only after Step 2 is fully verified: update the registrar's nameservers to Cloudflare's.
- Wait for propagation; confirm `dig`/`nslookup` for the MX record and the main A/CNAME record still resolve correctly.
- At this point Cloudflare is the authoritative DNS, but every record is still grey-cloud (not proxied) — traffic still goes direct to Vercel, unchanged.

## Step 4 — Enable proxying for static-asset caching only (Gate B)

- Apply the Cache Rule from `cloudflare/cache-rules.md` (allowlist: `/downloads/*`, `/_next/static/*`).
- Switch the `www`/apex record to proxied ("orange-cloud").
- Run the Gate B verification checklist from `cloudflare-rollout-plan.md` (installer downloads, checksums, dynamic-route bypass, SSE/long-poll, a real webhook signature) before calling this step done.

## Step 5 — (Optional, only if requested later) Worker deployment

- Review `cloudflare/worker/` (if scaffolded) against risk register #7 before deploying.
- Deploy to a Worker route scoped only to the paths it's meant to handle — never a catch-all route for the zone.

## Step 6 — (Optional, not planned) R2

- Not part of this pass's scope. If ever wanted, see `cloudflare-rollout-plan.md` Gate D — it's a storage-provider decision (`src/lib/pinningProviders/`), separate from the DNS/edge work above.

## Rollback (any step)

- DNS: revert nameservers at the registrar back to the previous provider — reversible at any point, with normal DNS propagation delay.
- Cache Rules: disable the specific rule in the Cloudflare dashboard — immediate, no DNS change needed.
- Proxying: switch a record back to grey-cloud (DNS-only) — immediate, traffic reverts to direct-to-Vercel.
- Worker: delete the Worker route — immediate, does not affect DNS or Cache Rules.

## What I will not do without your explicit go-ahead at each step

- Create or configure anything in a real Cloudflare account.
- Change any DNS record or nameserver.
- Enable proxying on any record.
- Deploy a Worker, create an R2 bucket, or activate any paid Cloudflare feature.
- Perform or schedule a production cutover.
