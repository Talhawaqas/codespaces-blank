# Cloudflare Integration — Data / Route Classification

Classifies every category of traffic found in `cloudflare-audit.md` into how an edge/CDN layer is allowed to treat it. This is the basis for the Cache Rules spec in `cloudflare/cache-rules.md` and for the Worker skeleton's allowlist, if one is ever deployed.

## Never-cacheable, never-transformed, identity-sensitive

Everything under these paths must hit the origin on every request, with no edge caching, no body transformation, and no header injection of any identity claim:

- `/api/orgs/**` (586 routes — session-cookie-authenticated Business Workspace)
- `/api/public/v1/**` (API-key-authenticated public API)
- `/api/admin/**` (shared-passphrase platform-operator dashboard)
- `/api/metadata/**`, `/api/nodes/**`, `/api/wallet/**` (wallet-signature-authenticated)
- `/api/infrastructure/**` (certificate/PKI-authenticated node-cluster daemon traffic)
- `/api/s3/**`, `/api/azure/**` (authenticated storage-gateway surface — now explicitly `Cache-Control: private, no-store` at the origin as of this pass, but an edge default-allow rule must never override that)
- All webhook receivers: `/api/stripe-webhook`, `/api/support/inbound-email/resend`, `/api/referrals/webhook`, `/api/watcher/telegram/webhook`, `/api/integrations/identity/webhooks/**`, `/api/workflow-hooks/**` — raw body bytes must reach the origin unmodified (no re-encoding, no gzip re-compression change, no WAF body-rewrite rules)
- `/api/cron/**` (Vercel Cron-triggered; not meant to be reachable from the public internet through an edge proxy at all — see risk register)

## Streaming / long-poll — no buffering, no short timeouts

- `/api/meet/rooms/[roomId]/stream` (SSE)
- `/api/orgs/chat/stream` (SSE)
- `/api/meet/rooms/[roomId]/signal` (long-poll)

Any edge layer must disable response buffering for these paths and must not impose an idle/connection timeout under 30 seconds (matching the origin's own `maxDuration = 30`).

## Static, cacheable, non-authenticated — the only "cache by default" candidates

- `/downloads/**` (desktop installer binaries, `public/downloads/**`)
- `/_next/static/**` (Next.js build assets — already content-hashed, safe to cache aggressively)
- `/favicon.ico`, other static marketing assets under `public/`
- `/api/health` (new in this pass — cheap, no-auth, but still `no-store` at the origin; a CDN may still *probe* it without caching the response)

## Everything else (marketing pages, docs pages, etc.)

Default to pass-through, no special edge caching rule added in this pass. These are low-risk either way (no auth, no secrets) but weren't part of the audited route inventory above and aren't being actively changed.

## Rule for any future addition

Before adding a new route to the cacheable list: check whether it reads from `src/lib/orgs.js:requireMembership()`, `metadata-auth.js`, `api-keys.js:requireApiKey()`, admin-auth, or certificate auth. If it does, it stays in the never-cacheable list, full stop — this matches the SOW's own default-deny caching posture.
