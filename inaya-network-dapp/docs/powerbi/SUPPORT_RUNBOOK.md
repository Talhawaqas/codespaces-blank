# Power BI integration: internal support runbook

SOW INAYA-BOS-POWERBI-SOW-2026-V1 · Customer guide: `/docs/products/power-bi` · Code: `src/lib/analytics/` (oauth.js, datasets.js), `src/app/api/analytics/`, `powerbi/connector/Inaya.pq`, `scripts/powerbi/`

## Switch it on for a company (pilot)
1. The company must be on **Enterprise** (`org.plan`), or be legacy or grandfathered.
2. Set `orgs.features.FEATURE_POWER_BI = true` for that company. Companies can't switch it on themselves (`PAID_ADDONS` in `/api/orgs/features`). Setting the environment variable `FEATURE_POWER_BI=on` turns it on for every entitled company; `off` is a kill switch.

## Where things are
| What | Where |
|---|---|
| Connections (grants) | `api_keys`, `kind: "oauth_grant"` (email, orgId, createdAt, lastUsedAt, refreshedAt, revokedAt, revokedBy). Refresh tokens are stored only as hashes |
| Authorisation codes and emailed sign-in codes | `mfa_pending`, purpose `pbi-code` / `pbi-email-code` |
| Audit | `org_activity`, recordType `POWER_BI`: POWERBI_CONNECTED, POWERBI_REVOKED, POWERBI_DATA_READ (dataset, window, first-page rows), POWERBI_SETTINGS_UPDATED |
| Rate limits | `rate_limit_hits`, actions `analytics-api` (per connection: 600 per 10 minutes), `analytics-token`, `pbi-email-code` |

## Common requests
- **Disconnect someone now:** they or an admin use Admin > Integrations > Microsoft Power BI > Disconnect. Every API call re-checks the connection, so it takes effect immediately.
- **"Refresh failed: revoked/expired":** connections expire after 90 days without a refresh. Reusing an old refresh token revokes the connection (a possible token-theft signal). The customer signs in again in Data source settings.
- **"Only owners and admins can connect":** an admin enables *Let members connect Power BI*.
- **Empty table:** the person's role can't read that dataset (by design: it loads empty, so the rest of the refresh still works), or there's no data in RangeStart/RangeEnd.
- **Service refresh fails:** almost always the gateway. Check it's online, has Inaya.mez in its custom connectors folder with custom connectors enabled, and has a signed-in "Inaya Business OS" connection.
- **"The remote name could not be resolved: 'www.inayanetwork.com'" (DM_GWPipeline_Gateway_MashupDataAccessError):** the gateway machine's DNS failed, not Inaya (seen live 27 Nov 2026 on a VMware NAT VM). On the gateway machine: set reliable DNS servers, `ipconfig /flushdns`, check `Resolve-DnsName www.inayanetwork.com`, `Restart-Service PBIEgwService`, then refresh again.
- **Service sign-in window stays blank (gatewayadminportal.azure.com/OAuthRedirect):** the popup lost its opener. `/business/powerbi-authorize` and `/api/orgs/login/*` must keep `Cross-Origin-Opener-Policy: unsafe-none` (next.config.mjs); check with `curl -sI`.
- **Numbers differ from Inaya screens:** check the currency slicer, the date basis (sales by completion, refunds by refund date, invoices by issue date) and voided or deleted rows. The sales definitions are covered by `test/powerbi.test.mjs` (reconciliation with the Commerce report).

## Rebuilding the deliverables
```
node --env-file=.env.local --input-type=module -e "import {DATASETS} from './src/lib/analytics/datasets.js'; ..."   # see scripts/powerbi/starter.py header
python scripts/powerbi/starter.py && python scripts/powerbi/docs.py && python scripts/powerbi/build.py
```
Within API v1, only ever add fields. Never rename or remove them. Bump the connector version text in Inaya.pq and the docs when the connector changes.

## Known limits (state these honestly)
- The connector is uncertified. Desktop needs the "allow any extension" setting, and the Service needs a gateway. Signing (a code-signing certificate) and Microsoft certification are later owner decisions.
- Import mode only, on a schedule. No DirectQuery and no real-time data. No availability SLA has been published.
