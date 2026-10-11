# Cloudflare Integration — Phase 0 Audit

Required by the Cloudflare SOW's own §1 ("mandatory audit gate — must inspect repo layout, DNS/hosting, API route inventory, auth/session/tenant flows, data flows, existing tests before any code/config change"). Everything below was independently verified against the live repository (two parallel audit passes) and, where noted, against facts already confirmed in prior session work — nothing here is assumed from the SOW's own framing.

## 1. Hosting — confirmed Vercel

- `.vercel/project.json`: `projectId: prj_lSQSjOLM8kxFs7RcvlaSYRL7OkNq`, `orgId: team_ZF5TdeYeT5PKt3prvqn6imfm`, `projectName: codespaces-blank`.
- `vercel.json` (repo root) defines 30 Vercel Cron Jobs — a Vercel-specific platform feature, not portable to another host without rework.
- `package.json` depends on `@vercel/analytics`, `@vercel/blob`, `@vercel/sandbox`, `@vercel/speed-insights`.
- Vercel project **Root Directory** build setting is `inaya-network-dapp/` (per `.vercelignore` comments); `vercel deploy` runs from the monorepo root where `.vercel/project.json` is linked.
- No `vercel build`/`vercel deploy` npm scripts — deploys happen via Vercel's git-push integration, not CLI.
- `src/lib/rateLimit.js`'s `getClientIp()` explicitly relies on Vercel's documented `x-vercel-forwarded-for` anti-spoofing header ordering.
- **This app has no `.github/workflows/` directory and no other CI config** — there is nothing for Cloudflare to plug into at the CI/CD layer. (CI exists in the separate sibling repos `custody-sdk` and `inaya-mobile`, unrelated to this SOW.)

## 2. Domain / DNS

- Production hostname confirmed from hardcoded app strings (not from any DNS config in this repo, which has none): `https://www.inayanetwork.com` (`src/app/layout.js` `metadataBase`, `src/app/sitemap.js`, `src/app/robots.js`), with an `inayanetwork.com` fallback in `src/lib/documentAutomation/pipeline.js`.
- The committed `.env.local` sets `NEXT_PUBLIC_APP_URL="http://localhost:3000"` for local dev — the real production value lives only in Vercel's dashboard env vars, not in the repo.
- **Known real DNS record** (confirmed in prior session work, not from this repo): `support.inayanetwork.com` has live **MX records** for Resend inbound email. This is a concrete record that must be explicitly preserved/imported before any Cloudflare nameserver cutover — see `cloudflare-risk-register.md`.
- Actual DNS zone contents and registrar are not visible from the repo and must be confirmed directly in the registrar/Vercel dashboard before any onboarding step.

## 3. Security headers / CSP

Set in `next.config.mjs`'s `headers()`, applied globally (`source: "/:path*"`):

- `Content-Security-Policy: frame-ancestors 'self';` — **the only CSP directive set**, deliberately. No `script-src`/`connect-src`/etc., because the app loads Stripe, Firebase, Google Sign-In, and WalletConnect from many origins and an incomplete allowlist risks breaking the live app.
- `X-Frame-Options: SAMEORIGIN` (overridden to `ALLOWALL` + a Microsoft-only `frame-ancestors` for `/outlook/:path*`, the Outlook add-in task pane).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
- `Permissions-Policy` deliberately omits microphone (used by `useVoiceSession.js`).
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` — chosen specifically so it doesn't break OAuth popup flows and WalletConnect.

**Implication**: any Cloudflare-managed ruleset that adds its own CSP, COOP, or frame-ancestors policy in front of this would be a net-new restriction this app has never had to satisfy, and could break wallet connections or the Outlook add-in. Any such Cloudflare feature must stay disabled for this app's zone, or be configured to pass Vercel's own headers through unmodified.

## 4. CORS

- No `Access-Control-Allow-Origin` header is set anywhere in `src/`. The app grants no cross-origin API access by design.
- Cross-site protection is instead bespoke per-feature: e.g. `src/lib/support/portalApi.js`'s `csrfCheck()` requires a custom `X-Portal-Request: 1` header (which a cross-site request cannot attach without triggering a CORS preflight the app never grants) plus an Origin/Host match.
- Nothing here needs or should be replaced by a Cloudflare CORS feature.

## 5. Rate limiting

- `src/lib/rateLimit.js`: MongoDB-backed sliding-window limiter, chosen explicitly over Redis/Upstash so state doesn't reset per cold start or diverge per serverless instance.
- Applied **opt-in, per-route** — only 45 of 876 API route files call it. `src/middleware.js` has no rate-limiting logic. This is not a candidate for a Cloudflare-side migration in this pass; a Cloudflare rate-limiting rule would be additive (an extra layer), never a replacement.

## 6. Storage abstraction — correction to the SOW's assumption

- The SOW's briefing assumed `src/lib/s3-compat/*` is an outbound S3 client that could point at R2 "via config alone." **This is backwards**: `s3-compat/*` is Inaya's own server-side *emulation* of an S3-compatible API surface (`/api/s3/[bucket]/[...key]`) for external tools (AWS CLI, `aws s3 sync`) to talk to Inaya — it writes through Inaya's own custody-sdk encryption pipeline and pinning providers, never to a real S3 bucket.
- The actual outbound S3-compatible client is `src/lib/pinningProviders/filebase.js`, which constructs a real `@aws-sdk/client-s3` `S3Client` against a **hardcoded** endpoint constant (`https://s3.filebase.io`). It is registered in the provider-agnostic `src/lib/pinningProviders/index.js` `PROVIDERS` map.
- If Inaya ever wanted R2 as an additional pinning backend, that would be a new sibling provider file following the existing `pin/fetchReplica/getPinStatus/unpin/isConfigured` interface — unrelated to, and much lower-risk than, putting Cloudflare in front of live traffic. **Not part of this pass.**

## 7. Existing edge middleware

`src/middleware.js` (the only Next.js middleware file) does three things, two of them currently inert:

1. Decodes a doubly-percent-encoded AzCopy path (`/api(/|%2F)azure%2F...`) — always active.
2. If `AZURE_COMPAT_HOST_BASE` is set (currently unset), rewrites Host-matched requests to `/api/azure${path}`.
3. If `S3_COMPAT_VIRTUAL_HOST_BASE` is set (currently unset; example given in-code: `"s3.inayanetwork.com"`), rewrites subdomain-addressed requests to `/api/s3/${bucket}${path}`.

**Implication**: a Cloudflare Worker placed in front of this app must never duplicate this Host-header-based bucket/container routing logic, especially if either env var is ever turned on later.

## 8. Secrets / env var convention

- Established pattern for new third-party secrets: a flat, Vercel-dashboard-set env var (e.g. `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`), used directly as a server-only process env var.
- A dedicated `*_ENCRYPTION_KEY` (AES-256-GCM) wrapper (`src/lib/integrationCrypto.js`, `src/lib/mfaCrypto.js`) is used **only** when a secret of that class must be stored at rest in MongoDB per-org — not for every secret in the app.
- For Cloudflare: new `CLOUDFLARE_*` env vars (API token, zone ID, R2 keys if ever used) follow the flat convention; the AES-256-GCM wrapper is not needed unless a per-org Cloudflare credential is ever stored in the database (not in scope for this pass).

## 9. API surface — scale and shape

- **876 `route.js` files** across 55 top-level directories under `src/app/api/`. Largest: `orgs/` (586 routes — the session-cookie-authenticated Business Workspace), `public/` (38 routes — API-key-authenticated `public/v1/*`), `admin/` (30 — shared-passphrase platform-operator dashboard), `cron/` (24 — Vercel Cron), `metadata/` + `nodes/` (17 each — wallet-signature-authenticated personal/dApp and legacy node-daemon surfaces).

### Auth mechanisms (five, not one)

1. **Org session cookie** (`src/lib/orgs.js`): `inaya_org_session`, 30-day TTL, only `sha256(token)` stored. `requireMembership()` resolves cookie → session → DB-read role, plus device-revocation gating. Covers `orgs/*`.
2. **Google OAuth → same session system** (`orgs/login/google`): verifies a Google ID token, then calls the same `createSession()`.
3. **Wallet-signature auth** (`src/lib/metadata-auth.js`): bespoke signed-message scheme (`ethers.verifyMessage`), cross-checked against an on-chain custody contract. Deliberately separate from org sessions per the code's own comment.
4. **API keys** (`public/v1/_lib.js`'s `requireApiKey()`): `Authorization: Bearer <token>` resolved against a hashed `apiKeys` collection; `orgId` always derives from the key record, never the request.
5. **Certificate/PKI tokens** (`src/app/api/infrastructure/nodes/{enroll,heartbeat}`): one-time enrollment token → certificate-signed `signedToken` for ongoing auth — a third machine-client mechanism, distinct from #3's wallet signatures and #4's API keys.

A sixth, simpler mechanism gates `admin/*`: a single shared passphrase (`ADMIN_DASHBOARD_PASSPHRASE`), hashed into an `inaya_admin_session` cookie, `timingSafeEqual`-compared — not a per-user role.

**Implication**: any edge layer (Worker or otherwise) must never trust or inject identity headers — every one of these six mechanisms re-derives identity from a cookie/token/signature/certificate it looks up or verifies itself, never from a client-supplied header claim.

## 10. Streaming / long-poll routes — proxy-fragile

Exactly two SSE routes and one long-poll route, all explicitly disabling buffering:

- `src/app/api/meet/rooms/[roomId]/stream/route.js` and `src/app/api/orgs/chat/stream/route.js`: `Content-Type: text/event-stream`, `Cache-Control: no-store, no-transform`, `Connection: keep-alive`, **`X-Accel-Buffering: no`**, `maxDuration = 30`.
- `src/app/api/meet/rooms/[roomId]/signal/route.js`: long-poll (`?wait&since&cursorSeq`), same `maxDuration = 30`.

**Implication**: any edge/CDN layer in front must pass these through unbuffered, must not impose an idle/connection timeout shorter than 30s, and must not attempt to cache or transform the response body.

## 11. Webhook receivers — raw-body-dependent

All of the following read the **raw request body** before any parsing, specifically for signature verification, and must never have their bytes re-encoded, decompressed/recompressed, or buffer-transformed by an intermediary:

- Stripe (`stripe-webhook`) — `stripe-signature` header, `stripe.webhooks.constructEvent`.
- Resend inbound email (`support/inbound-email/resend`) — Svix-style signature headers.
- Didit KYC (`referrals/webhook`) — `X-Signature-V2`/`X-Signature`.
- Telegram (`watcher/telegram/webhook`) — shared-secret header, `timingSafeEqual`.
- Generic identity-provider relay (`integrations/identity/webhooks/[provider]`) — HMAC-SHA256 over `"<timestamp>.<rawBody>"`, 256KB cap, 5-minute replay window.
- Per-workflow custom webhooks (`workflow-hooks/[workflowId]`) — HMAC-SHA256, per-workflow secret, 64KB cap.

## 12. Caching — a real gap found, independent of Cloudflare

- **No app-wide default `Cache-Control` exists.** `next.config.mjs`'s global `headers()` sets security headers only; caching is 100% delegated to individual routes.
- The dominant per-route pattern (via shared `_lib.js` wrappers across `orgs/*` and `public/v1/*`) is `Cache-Control: no-store`.
- **Gap**: `src/app/api/s3/[bucket]/[...key]/route.js` (the authenticated S3-compatible object gateway) set **no `Cache-Control` header at all** on its GET/HEAD responses before this SOW pass — unlike the sibling `dataroom/documents/[id]/stream` route, which explicitly sets `private, no-store`. This was only safe because nothing in front of the app caches by default today. **Fixed as part of this pass** (see `cloudflare-rollout-plan.md`) — `Cache-Control: private, no-store` was added to all three GET/HEAD response paths in that route, independent of whether Cloudflare is ever deployed.
- The only genuinely public, cacheable route found: `help/config/route.js` (`Cache-Control: public, max-age=60`).

## 13. Health / status routes

- **No generic, public, DB-free `/api/health` existed before this pass.** Every other status-shaped route (`/api/metrics`, `/api/nodes/status`, feature-scoped health routes under `orgs/*`) either requires auth or touches MongoDB.
- Added in this pass: `src/app/api/health/route.js` — public, `Cache-Control: no-store`, no DB access — as a canary target for edge/CDN health checks.

## 14. Static, high-value, low-risk Cloudflare candidate

- Desktop installer binaries (`public/downloads/dapp/**`, `public/downloads/business-workspace/**`, up to ~86MB each) are served as static files directly from the Vercel-hosted Next.js app's `public/` directory, with **no CDN in front today**. This is exactly the kind of static, unauthenticated, cacheable asset that is safest to put behind Cloudflare first — see `cloudflare-rollout-plan.md`.
- Mobile APK distribution is entirely separate (GitHub Actions artifacts / GitHub Releases from the `inaya-mobile` repo) and out of scope for this SOW.
