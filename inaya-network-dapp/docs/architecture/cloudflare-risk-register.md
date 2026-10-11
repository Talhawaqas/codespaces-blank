# Cloudflare Integration — Risk Register

Each risk below is tied to a concrete fact from `cloudflare-audit.md`, not a generic concern. "Mitigation (this pass)" is what's done in code/docs now; "Mitigation (operator)" is what only the operator can do, tracked in `cloudflare-operator-runbook.md`.

## 1. DNS record loss during nameserver cutover

**Risk**: a naive Cloudflare onboarding (point nameservers at Cloudflare before importing/verifying existing records) can silently drop a record Cloudflare's scan missed.

**Verified 2026-10-11 against the live zone** (Hostinger, the current DNS host, and a real Cloudflare onboarding scan): `support.inayanetwork.com` does **not** exist as a DNS record — a prior session note claiming it had live MX records for Resend inbound email was stale; that setup step was never actually completed. The real, current record set (16 records) is: apex `A` (76.76.21.21, Vercel) and `MX` (mx1/mx2.hostinger.com), a `pilot` subdomain `A` record (also 76.76.21.21, Vercel — a second deployment target not previously documented), `www` CNAME (→ Vercel), three Hostinger-mail DKIM CNAMEs, `autoconfig`/`autodiscover` CNAMEs, a `send` subdomain MX/SPF/DKIM trio (Resend's **outbound**-sending setup, not inbound receiving), apex SPF + Google site-verification TXT, and `_dmarc` TXT.

**Confirmed gap in Cloudflare's own scan**: its automated DNS import found only 1 `A` record, missing the `pilot` subdomain entirely — direct, concrete proof of its own warning banner ("may have missed uncommon records or custom subdomains"). This record must be added manually before cutover.

**Mitigation (this pass)**: documented here with the verified record set, so the operator runbook checks against reality instead of a stale assumption.
**Mitigation (operator)**: before changing nameservers, confirm Cloudflare's DNS tab has all 16 records matching Hostinger's panel exactly — specifically add the missing `pilot` A record (76.76.21.21) by hand. Keep every record DNS-only (grey cloud) through this verification step.

## 2. CSP/COOP conflict with wallet and OAuth flows

**Risk**: the app's CSP is deliberately minimal (`frame-ancestors` only) because it loads Stripe/Firebase/Google/WalletConnect from many origins; `Cross-Origin-Opener-Policy: same-origin-allow-popups` is deliberately chosen to not break OAuth popups. A Cloudflare-managed security ruleset that adds its own CSP/COOP would silently break wallet connections, Google/Microsoft/Slack OAuth popups, or the Outlook add-in's `frame-ancestors` carve-out.

**Mitigation (this pass)**: documented in the audit; the rollout plan explicitly excludes any Cloudflare "Browser Integrity Check"/managed security headers feature from this pass's scope.
**Mitigation (operator)**: if any Cloudflare security ruleset is ever enabled, test every OAuth/wallet-connect flow in staging first, not production.

## 3. Streaming/long-poll breakage

**Risk**: `meet/rooms/[id]/stream`, `orgs/chat/stream` (SSE), and `meet/rooms/[id]/signal` (long-poll) explicitly disable buffering (`X-Accel-Buffering: no`) and cap at 30s. A CDN/proxy that re-buffers responses or imposes a shorter idle timeout would break real-time chat and meeting signaling.

**Mitigation (this pass)**: documented in the data classification doc; any Cache Rule or Worker route must explicitly bypass/exclude these three paths.
**Mitigation (operator)**: if Cloudflare proxying is ever enabled for these paths, verify a real Meet session and a real chat session still work end-to-end in staging before any production cutover.

## 4. Webhook signature verification breakage

**Risk**: six inbound webhook receivers (Stripe, Resend, Didit, Telegram, generic identity-provider relay, workflow hooks) verify signatures over the **raw** request body. Any edge feature that decompresses/recompresses, rewrites, or otherwise touches the body before it reaches the origin would break signature verification and silently drop real webhook events (payments, inbound support email, KYC callbacks, Telegram bot messages).

**Mitigation (this pass)**: documented; these paths are in the never-transform list in the data classification doc.
**Mitigation (operator)**: disable any Cloudflare "Auto Minify" / body-rewrite feature globally, or explicitly exclude these paths, before enabling proxying on this zone.

## 5. Default-allow caching of authenticated bytes

**Risk**: the audit found `src/app/api/s3/[bucket]/[...key]/route.js` set no `Cache-Control` at all on GET/HEAD before this pass — meaning a future default-allow edge cache rule could have cached authenticated, per-tenant object bytes and served them to the wrong requester.

**Mitigation (this pass)**: **fixed directly in code** — `Cache-Control: private, no-store` added to all three GET/HEAD response paths in that route, independent of Cloudflare. Also captured as a standing rule in the data classification doc: any Cache Rule added for this zone must be an explicit allowlist (static paths only), never a default-allow with exceptions.
**Mitigation (operator)**: when configuring Cloudflare Cache Rules, use an allowlist expression (match `/downloads/*` or `/_next/static/*`), never a "cache everything except" rule.

## 6. Cron endpoints exposed to the public internet

**Risk**: `vercel.json` defines 30 Cron-triggered routes under `/api/cron/**`. These are meant to be invoked only by Vercel's own cron scheduler (which Vercel authenticates internally), not reachable from arbitrary internet traffic through a new edge proxy.

**Mitigation (this pass)**: flagged in the data classification doc as never-cacheable/never-proxied-to-public.
**Mitigation (operator)**: if Cloudflare ever proxies this zone, confirm `/api/cron/*` is either excluded from any public Worker route or still enforces whatever origin-check these routes already rely on (Vercel's own cron-secret/header convention) — verify in staging, not production.

## 7. Worker trusting client-supplied identity

**Risk**: the app has five+one real auth mechanisms (session cookie, OAuth-into-session, wallet signature, API key, certificate/PKI, admin passphrase), none of which are "trust a header." A naively written Worker could introduce a new, weaker implicit-trust path (e.g. forwarding a client header as if it were verified identity).

**Mitigation (this pass)**: the Worker skeleton (if scaffolded) explicitly never reads or forwards any identity-shaped header as trusted; it only does hostname allowlisting and static-asset cache decisions, per the SOW's own Worker rules.
**Mitigation (operator)**: any future Worker code review must confirm it still does not trust client headers before it is ever deployed to a real account.

## Rollback

Every feature in the rollout plan (`cloudflare-rollout-plan.md`) is independently reversible: DNS can be switched back to direct-to-Vercel at the registrar, Cache Rules can be disabled per-rule, Workers routes can be deleted without affecting DNS. No feature in this plan is an all-or-nothing cutover.
