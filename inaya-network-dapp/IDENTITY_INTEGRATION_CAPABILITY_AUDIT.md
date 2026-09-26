# Identity Integration: Phase 0 capability audit and gap matrix

Scope: `Inaya_Web2_Identity_Automation_Rewst_AD_Entra_SOW.md`. Written before implementation, from the repository as it stood on 2026-09-26. Classification vocabulary from SOW §2: ALREADY IMPLEMENTED, PARTIALLY IMPLEMENTED, GENUINELY ABSENT, INTEGRATION GAP, UNVERIFIED, NOT APPLICABLE.

## 1. What Inaya already has (and will be reused, not rebuilt)

| Area | Finding | Where |
|---|---|---|
| Identity model | There is **no separate user table**. A person is an email address. An organization membership is a row in `org_members` (`role` owner/admin/member, `status`, `departmentIds`, optional `financeRole`, `hrRole`, `supportRole`, `storageRole`, `escrowRole`, `complianceRole`, `managedDepartmentIds`, `notifyOnApprovals`). | `lib/orgs.js` |
| Authorization | Every org route calls `requireMembership()`, which reads the membership row (`status: "active"` only) on **every request**; roles are never trusted from the client. Pure gates: `canManageOrg`, `canAccessDepartment`, `canAccessFinance/HR/Storage/Escrow/Compliance`. | `lib/orgs.js`, `lib/orgGates.js` |
| Sessions | `sessions` collection keyed by **email** (not by org), token stored hashed, 30-day TTL. A session alone grants nothing: each org request re-resolves the membership. This is what makes "freeze authorization at the API boundary" possible. | `lib/orgs.js` |
| Authentication | Magic-link email, Google ID token, mobile bearer token. **No Entra sign-in to the Inaya web app.** | `lib/orgs.js`, `lib/googleAuth.js` |
| Entra ID (existing) | (a) A real per-user delegated OAuth connection to Microsoft Graph (`integrationProviders/microsoft.js`) for the Integrations catalog; (b) **Entra bearer-token authentication for Azure Blob** requests, mapped to an existing active membership **by email** (`s3-compat/azureAuthMiddleware.js`). Neither does directory sync, provisioning or lifecycle. | as listed |
| SSO/provisioning | `integrations/sso.js` is an **unconfigured stub** (`provisionUser`, `deprovisionUser`, `syncRoleMapping` throw "not configured"). Nothing calls it. | `lib/integrations/sso.js` |
| Integrations registry | Catalog of provider connections with an honest state machine (`ACTIVE` only after a real sync run). Reusable pattern; not an identity engine. | `lib/integrations.js` |
| Credentials | `api_keys` (org bearer keys, hashed, `createdByEmail`), `s3_credentials` (SigV4, org-owned, `createdByEmail`, optional scope + expiry, revocable), workflow/integration credentials (encrypted, `integrationCrypto.js`), Customer-Portal support API keys. | `lib/api-keys.js`, `lib/s3-compat/credentials.js`, `lib/integrationCrypto.js` |
| Access grants tied to a person | `project_members` (email), `document_permissions` (email), `document_shares` (share links with `createdByEmail`, `revokedAt`), vertical assignments (health care-team, legal matter-team; health break-glass with `expiresAt`), workflow ownership (`ownerEmail`; the scheduler already re-checks the owner's membership and **fails closed**). | `lib/document-permissions.js`, `lib/health-breakglass.js`, `lib/workflows/queue.js` |
| Approvals | Controlled Actions (`ai_action_requests`): human approval, **36-hour delay**, idempotent, risk classification, executor registry, cron execution. | `lib/ai-action-requests.js`, `lib/ai-action-approval-gate.js` |
| Audit / evidence | `logOrgActivity` (hash-chained), Evidence Graph (`businessEvents`, typed relationships, passport, explain), notifications with dedupe keys, Activity Center. | `lib/org-activity-log.js`, `lib/businessEvents.js`, `lib/notifications.js` |
| Digital Twin | `simulateDigitalTwinScenario` already has **`EMPLOYEE_ACCESS_REMOVED`** (entity = person's email; lists project memberships and assigned tasks, department-filtered, never mutates). | `lib/digitalTwinSimulate.js`, `lib/digitalTwin.js` |
| Webhook / signature patterns | HMAC-with-timestamp verification already used for workflow webhooks and Customer Portal inbound email. Rate limiter (`checkRateLimit`), idempotency stores. | `lib/workflows`, `lib/support`, `lib/rateLimit.js` |
| Scheduler | Vercel cron (paid plan, every 5 minutes) with `CRON_SECRET` bearer. | `vercel.json`, `app/api/cron/*` |

## 2. Gap matrix

| Capability (SOW) | Current state | Classification | Action |
|---|---|---|---|
| External identity mapping (§7) | None (only email matching in Azure auth) | GENUINELY ABSENT | New durable mapping, keyed by provider tenant + immutable object id; email only as controlled fallback; ambiguity fails closed |
| Tenant → organization mapping, MSP (§8, §25) | None | GENUINELY ABSENT | New provider registry with one-tenant-one-org uniqueness; MSP link model (customer-approved) |
| Joiner / Mover / Leaver engine (§11-12) | Membership create/invite exists; no lifecycle engine | INTEGRATION GAP | New engine calling existing membership, department, project and role structures |
| Baseline + manual override (§13) | Roles are hand-edited on the membership row with no notion of source | GENUINELY ABSENT | Grant ledger with `source` (AD/ENTRA/HR/SCIM/INAYA_MANUAL_OVERRIDE); effective access is derived and written back to the existing membership fields |
| Immediate revocation (§14-16) | Nothing orchestrates it; single revocations exist (S3 credential revoke, share revoke) | INTEGRATION GAP | New revocation state machine that reuses those primitives; membership suspension is the fail-closed control |
| Group and attribute mapping (§17-18) | None | GENUINELY ABSENT | Versioned, audited mapping policies; privileged roles need explicit policy + Controlled Action |
| Reconciliation and drift (§24) | None | GENUINELY ABSENT | Snapshot comparison producing MATCH/DRIFT/CONFLICT/UNRESOLVED; never auto-deletes |
| SCIM (§19) | None | GENUINELY ABSENT | SCIM 2.0 `/Users` and `/Groups` bound to the same engine (deactivate, never delete) |
| Rewst / RMM / PSA / HR (§20-29) | None | NEW INTEGRATION | Signed webhook + service-credential REST API + OpenAPI + reference workflows; generic HR/PSA/RMM adapters via normalization, no vendor connectors |
| Active Directory (§9) | None; no LDAP | GENUINELY ABSENT | **No inbound LDAP from the cloud.** Connector pattern: customer AD → RMM/Rewst/agent → authenticated Inaya API |
| Entra provisioning (§10) | Only user OAuth + Azure Blob auth | INTEGRATION GAP | Entra payload adapter (Graph change notifications / Lifecycle Workflow payloads) + optional Graph pull with client credentials |
| Temporary and contractor access (§30) | S3 credential `expiresAt` and health break-glass exist; no general facility | PARTIALLY IMPLEMENTED | Grant ledger with start/expiry/owner/purpose and a worker that revokes and verifies |
| Access reviews (§31) | None | GENUINELY ABSENT | Campaigns with APPROVE / MODIFY / REVOKE, audited |
| Orphan detection and manager replacement (§32-33) | None | GENUINELY ABSENT | Detection + **remediation tasks** in the existing task system; no silent reassignment |
| Security incident lockdown (§34) | AI-security events exist; no identity response | INTEGRATION GAP | Restrict/revoke/restore actions callable from an incident or an operator; no invented threat signals |
| Break-glass (§35) | Health vertical break-glass with expiry | ALREADY IMPLEMENTED | Reuse untouched; leaver revocation also ends the person's break-glass rows; vertical controls are never weakened |
| Integration credential lifecycle (§36) | Several credential kinds, no identity-integration credential | INTEGRATION GAP | Scoped service credentials: create, rotate, revoke, expire, last-used; webhook signing secrets encrypted |
| Dry-run (§37) | None for identity | GENUINELY ABSENT | Plan computed by the same code as the live path; exportable; zero mutation |
| Human approval (§38) | Controlled Actions (36 h delay) | ALREADY IMPLEMENTED | Reuse for **grants of privilege**. **Removal of access is never gated or delayed** (a delay on revocation would defeat its purpose) |
| Evidence Graph / audit / passport (§39-40) | Existing | ALREADY IMPLEMENTED | New subject types `IDENTITY_LIFECYCLE`, event types and relationships; no second graph |
| Digital Twin preview (§41) | `EMPLOYEE_ACCESS_REMOVED` exists | ALREADY IMPLEMENTED | Call it; add an identity-aware summary of the plan |
| Bulk and async jobs (§48) | Cron worker pattern exists | INTEGRATION GAP | Durable, resumable job documents processed by the cron worker |
| Observability (§49) | Metrics patterns exist | INTEGRATION GAP | Metrics computed from recorded runs; no invented figures |
| Admin UI (§44) | No identity view | GENUINELY ABSENT | Business Workspace "Identity & Access" |
| Documentation (§51) | None | GENUINELY ABSENT | Product guides, API reference, reference Rewst workflows, each labelled VERIFIED / PARTIAL / UNVERIFIED / UNSUPPORTED / FUTURE |

## 3. Design decisions (and why)

1. **Authority stays with Inaya.** External events change *inputs* (grants with a source); the effective access written to the existing membership fields is derived from the ledger. Nothing about RBAC is duplicated.
2. **Fail closed at the API boundary.** Revocation suspends the membership (`status: "revoked"`), which `requireMembership` already refuses on the next request, whatever sessions or tokens still exist. Sessions are additionally revoked. We state plainly that an external provider's own tokens cannot be recalled by Inaya (SOW §16).
3. **Removal is immediate, grants can wait.** Revocation, disable and restriction never go through the 36-hour delay. Granting privileged roles (admin, or any role a policy flags `privileged`) goes through Controlled Actions.
4. **Sessions are global per email.** Revoking every session of a person who still belongs to another organization would sign them out there too, so the default policy revokes sessions only when the person has no other active membership; `always` is available (used for compromise/incident). The per-org membership freeze is the real control either way.
5. **Ordering.** Each external identity carries a watermark (`sourceUpdatedAt` + optional sequence). An event not newer than the watermark is recorded as STALE and ignored, and an `enable` older than the last `disable` can never restore access. Re-enabling a previously revoked person is a *restore* that follows policy (`manual_review` by default), not an automatic re-grant.
6. **Tenant binding is explicit.** A provider tenant belongs to exactly one organization (unique index). Email-domain similarity is never used to pick an organization.
7. **No inbound LDAP.** Active Directory is reached through the customer's RMM / Rewst / connector, which calls the authenticated Inaya API (SOW §9).
8. **MSP.** An MSP organization can be linked to a customer organization only after the customer's owner or admin accepts. MSP service credentials are bound to the customers they are linked to; MSP technicians act only on assigned customers, within their delegated role.

## 4. Documented limits (stated up front)

- No real Entra tenant, Active Directory, Rewst account, PSA or RMM was available; those integrations are exercised against local stand-ins and are labelled **UNVERIFIED** until tested for real. No Microsoft or Rewst certification is claimed.
- Inaya cannot revoke tokens issued by an external identity provider; it enforces its own authorization on every request.
- Tenant claims are not proven against the provider (no domain-ownership handshake); a second claim of the same tenant is refused.
