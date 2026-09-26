# Identity Integration: Implementation Report

SOW: *Web2 Identity, Automation & MSP Integration (Active Directory, Microsoft Entra, Rewst, RPA)*.
Capability audit and gap matrix (Phase 0): [`IDENTITY_INTEGRATION_CAPABILITY_AUDIT.md`](../IDENTITY_INTEGRATION_CAPABILITY_AUDIT.md).
User documentation: `content/docs/identity/*` (14 pages, published in the docs platform). Reference workflows and a signing sample: `docs/identity-integration/`.

## What was built

| SOW section | Implementation |
|---|---|
| 7, 8 Identity and tenant mapping | `providers.js`, `mapping.js`: identity keyed by (provider tenant, immutable object id); email only as a controlled fallback (`exact_unique`), ambiguity fails closed; one tenant belongs to one organization (unique index). |
| 9, 10 Active Directory, Entra | Adapters in `normalize.js` (Entra, AD/RMM); optional Graph pull in `entraGraph.js`. No inbound LDAP by design. |
| 11, 12 Joiner, mover | `engine.js` plan then execute then verify; preserves manual, existing and other-source access. |
| 13 Manual override | `grants.js` ledger with sources; `overrides.js` (reason required, labelled `INAYA MANUAL OVERRIDE`). |
| 14, 15, 16 Revocation | `revocation.js`: freeze, sessions, credentials, permissions, sharing, break-glass, each independently verified; states PENDING / PARTIAL / COMPLETE / FAILED; retry only unverified steps; token and session reality documented. |
| 17, 18 Group and attribute mapping | `mapping.js` (versioned); owner never grantable; admin privileged, goes through Controlled Actions (`approvals.js`, type `IDENTITY_LIFECYCLE`). |
| 19 SCIM | `scim.js` and `/api/scim/v2`: Users, Groups, discovery, filters, PATCH; every write is a lifecycle event. |
| 20-23 Rewst, actions, events, webhooks | `api.js` (all SOW section 21 actions), `outbound.js` (section 22 events), webhook route with HTTPS, signature, timestamp, replay, size, tenant, schema, idempotency, rate limit (section 23). |
| 24 Reconciliation | `reconcile.js`: MATCH / DRIFT / CONFLICT / UNRESOLVED, chunked snapshots, reports only, optional remediation. |
| 25, 26 MSP | `msp.js`, `credentials.js`: two-sided links, MSP credentials bound to customers, four delegated roles, re-verified on each request. |
| 27-29 HR, PSA, RMM | Generic adapters into one canonical schema. |
| 30-33 Temporary access, reviews, orphans, manager replacement | `temporary.js`, `reviews.js`, `orphans.js`. |
| 34, 35 Incident, break-glass | Restrict/restore endpoints; break-glass is one revocation step (existing mechanisms reused, none weakened). |
| 36 Credential lifecycle | Create, scope, rotate, revoke, expire, last used, owner, provider; hashes only. |
| 37, 38 Dry run, approval | Exportable dry run ending `LIVE MUTATION: NO`; existing Controlled Actions, no second approval engine. |
| 39, 40 Evidence | Existing audit chain (record type `IDENTITY_LIFECYCLE`); Evidence Graph subject `IDENTITY_LIFECYCLE`; Business Event Passport via the existing builder. |
| 41 Digital Twin | `twin.js` reuses `EMPLOYEE_ACCESS_REMOVED`. |
| 43 API | `/api/integrations/identity/*` (one dispatcher, `api.js`). |
| 44 Admin UI | Business Workspace, Identity & Access (15 tabs), no fabricated metrics. |
| 45-47 Security, idempotency, failures | See tests below; failure classes and backoff in `common.js`, `worker.js`. |
| 48, 49 Bulk, observability | `jobs.js` (resumable, per-item), `metrics.js` (computed from durable rows), cron `/api/cron/identity` every 5 minutes. |
| 51 Documentation | 14 docs pages with VERIFIED / PARTIAL / UNVERIFIED / UNSUPPORTED / FUTURE labels. |
| SDK | `custody-sdk/src/identityIntegration.js` (`IdentityIntegration`). |

Existing files touched (additive): `orgs.js` (one collection handle), `businessEvents.js` (subject type), `ai-action-requests.js` and `ai-action-approval-gate.js` (executor and gate for `IDENTITY_LIFECYCLE`), `support/webhooks.js` (exports `post`; cloud-metadata hosts now refused even in local-test mode), `docsApiReference.js` and `public/openapi.json`, `vercel.json` (cron), `business/page.js` (nav entry).

## Acceptance scenarios (SOW section 50)

| Scenario | Test |
|---|---|
| A New employee | `identity-engine` A; `identity-api` webhook provisioning |
| B Termination | `identity-engine` B (every API refuses the person afterwards) |
| C Department transfer | `identity-engine` C |
| D MSP isolation | `identity-api` D |
| E Replay | `identity-api` webhook tests |
| F Partial revocation | `identity-engine` F; `identity-extras` worker retry |
| G Dry run | `identity-engine` G; `identity-api` G (exported text) |
| H Digital Twin | `identity-extras` H |

Also covered: privileged approval flow, owner protection, tenant conflicts, stale and racing events (disable, update, enable, disable ends disabled), existing-access preservation, restore, reconciliation, temporary expiry, access reviews, orphans, bulk jobs, outbound events, SCIM, Graph pull (stand-in), credentials and scopes, privilege-escalation attempts, secrets absent from responses and audit, evidence chain and export.

Test files: `test/identity-engine.test.mjs` (11), `test/identity-api.test.mjs` (9), `test/identity-extras.test.mjs` (10), `custody-sdk/test/identityIntegration.test.mjs` (3). All run against a real MongoDB; only the external systems are played by the tests.

## What is NOT verified (read this)

- **No real Microsoft Entra tenant, Active Directory domain, Rewst workspace, RMM, PSA or HR product was used.** Compatibility is not claimed for any of them. Entra events: PARTIAL. Graph pull: UNVERIFIED (local stand-in only). AD via RMM/Rewst: UNVERIFIED. Rewst: UNVERIFIED; the reference workflows are not a Rewst export. SCIM: PARTIAL (no real Entra or Okta provisioning job).
- Inaya cannot recall tokens issued by another provider (documented; access is blocked through the membership check instead).
- Sessions are per email, not per organization: a leaver's sessions are ended only when they have no other active membership (policy `sessionRevocation: always` overrides).
- Workflow and integration credentials are flagged, not auto-revoked.
- FUTURE: Okta / Google Workspace native connectors, Entra change-notification subscription management, SCIM bulk, an LDAP connector agent.

## Operating notes

No new environment variable is required. It uses `INTEGRATION_ENCRYPTION_KEY` (already set) for provider signing secrets and Graph secrets, and `CRON_SECRET` for the cron route. `GRAPH_LOGIN_BASE_URL` / `GRAPH_BASE_URL` exist only so tests can point at a stand-in.

Recommended before production use: connect one non-production tenant end to end (Entra, then Rewst), run a leaver and a joiner, and change the corresponding row in the compatibility table from UNVERIFIED to VERIFIED with the date and evidence.
