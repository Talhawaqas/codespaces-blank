# Cloudflare Cache Rules — Gate B spec

Not deployed. This is a reviewable spec for the operator to enter into the Cloudflare dashboard (Rules → Cache Rules) during `cloudflare-operator-runbook.md` Step 4. Cache Rules are dashboard/API configuration, not Worker code — there's nothing to "run" locally to test this file; it's reviewed as a document.

Source of truth for scope: `docs/architecture/cloudflare-data-classification.md`.

## Rule 1 — Cache static desktop installers

- **When incoming requests match**: `(http.request.uri.path wildcard "/downloads/*")`
- **Then**: Cache eligibility = Eligible for cache. Edge TTL = respect existing `Cache-Control`/explicit 1 day (these binaries change rarely; a short safety-net TTL avoids serving a stale installer indefinitely if a file is ever replaced without a cache purge). Browser TTL = respect existing header.

## Rule 2 — Cache Next.js static build assets

- **When incoming requests match**: `(http.request.uri.path wildcard "/_next/static/*")`
- **Then**: Cache eligibility = Eligible for cache. Edge TTL = 1 year (these paths are content-hashed by Next.js's build — a new deploy produces new hashed filenames, so aggressive caching is safe).

## Everything else — explicit default-deny (no rule needed, this is Cloudflare's own default)

No third "catch-all" rule is defined. Cloudflare's default behavior for a zone with only the two allowlist rules above is: nothing else is cached unless a rule says so. This is deliberate per `cloudflare-risk-register.md` risk #5 — an allowlist, never a "cache everything except" rule.

## Explicit exclusions (belt-and-suspenders, even though they're not matched by Rule 1/2 anyway)

If the dashboard UI makes it easy to add a third "bypass cache" rule for extra clarity, it should match:

- `/api/*` (all API routes — never cached, per the data classification doc)
- `/meet/rooms/*/stream`, `/api/orgs/chat/stream`, `/meet/rooms/*/signal` (streaming/long-poll — never cached, never buffered)

These are documented here so a future reviewer can see the intent even though Rule 1/2's allowlist already makes them unreachable by any cache rule.
