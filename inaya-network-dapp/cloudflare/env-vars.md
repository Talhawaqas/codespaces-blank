# Cloudflare — env var naming convention

No secrets are created or requested by this document — it only records the naming convention a future operator should follow when any Cloudflare-related secret is actually needed, matching the existing flat-env-var style already used for other third-party integrations (`FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `FILEBASE_BUCKET` — see `src/lib/pinningProviders/filebase.js`).

| Variable | Purpose | Where it would be set |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Scoped API token for any automation (e.g. a future script that manages Cache Rules via API instead of the dashboard) | Vercel project env vars (production/preview as needed), never committed |
| `CLOUDFLARE_ZONE_ID` | The zone ID for `inayanetwork.com` once it exists in a real Cloudflare account | Vercel project env vars |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID, only needed if a future Worker or R2 integration is built | Vercel project env vars |

None of these exist yet — no Cloudflare account has been created in this pass. Per the existing convention (see `src/lib/integrationCrypto.js`'s header comment), these stay as plain server-only env vars unless a per-org Cloudflare credential is ever stored in MongoDB, in which case it would go through the same AES-256-GCM wrapper pattern (`integrationCrypto.js`/`mfaCrypto.js`) with its own dedicated key — not in scope for this pass.
