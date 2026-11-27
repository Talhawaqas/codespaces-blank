# Power BI Integration: Phase 0 Audit

SOW: INAYA-BOS-POWERBI-SOW-2026-V1 · Audit date: 27 November 2026 · Status: **awaiting owner approval** (no implementation before approval, SOW §4)

Owner decision already given: **Power BI is for Enterprise customers only** (this replaces the SOW §12 proposal of Business and Enterprise).

## 1. What exists and is reused

| Area | Existing capability | Reuse |
|---|---|---|
| Tenant isolation | Every org route resolves membership server-side (`requireMembership`, `src/lib/orgs.js`); `orgId` never comes from the client in `public/v1` | Same rule: the company comes from the token, never the request |
| Branches | `member.locationIds` (branches = `warehouses`), enforced server-side by `memberLocations` / `scopeFilter` (`src/lib/workforce/scope.js`); owners/admins see all | Every branch-bearing dataset filters through `scopeFilter` |
| Roles | `role` owner/admin/member; `financeRole`, `hrRole`, `commerceRole`, `supportRole` (`ROLE_TEMPLATES`) | Dataset permissions map onto these roles |
| Package gates | `src/lib/planGates.js` (26 Nov) | New key `powerBi`, min Enterprise |
| Feature rollout | `FEATURE_*` flags (`src/lib/featureFlags.js`) | `FEATURE_POWER_BI` for pilot-first rollout |
| Licence gate | `companyMayOperate` (`src/lib/licensing/gate.js`) | A suspended company's analytics stop |
| Audit | `org_activity` via `logOrgActivity` | Connect, revoke, refresh, dataset access events |
| Rate limits | `rate_limit_hits` (`src/lib/rateLimit.js`) | Per-company and per-grant quotas |
| Reporting maths | Commerce reports (`src/lib/commerce/reports.js`) already define gross/net sales, discounts, returns and tax in integer minor units and reconcile to transactions | The Sales dataset and its measures use the same definitions, so Power BI matches Inaya's own reports |
| Data | `sales_orders` (POS and online, `channel`), `products`, `warehouses`, `stock_levels`, `stock_movements`, `crm_contacts`, `suppliers`, `purchase_orders`, `invoices`, `payments`, `expenses`, `journal_entries`, `ledger_accounts`, `employees`, `leave_requests`, rota and time records, Manage Orders jobs (`calendar_records` kind `ops_job`) | Read through one analytics layer |

## 2. Gaps found

1. **No OAuth authorisation server.** Inaya signs people in with sessions, and integrations use long-lived owner-level API keys (`src/lib/api-keys.js`). SOW §8.1 forbids long-lived static secrets for Power BI. **An OAuth 2.0 authorisation-code + PKCE server is required** (authorise, token, refresh, revoke) with short-lived access tokens and revocable refresh grants.
2. **No analytics API.** The `public/v1` families are operational and per-feature. A read-only, versioned analytics API (`/api/analytics/v1`) is needed, with dataset and field allowlists, pagination and incremental extraction.
3. **Uneven `updatedAt`.** Some collections have `updatedAt` (`sales_orders`), others only `createdAt` (`stock_movements`, `journal_entries`), and statuses change after creation. Incremental refresh must use a **rolling re-extraction window** (re-read the last N days on each refresh) plus a stable row key, so corrections and refunds arrive without duplicates. Soft-deleted rows (`deletedAt`) are exposed as `isDeleted`, not dropped.
4. **Workload isolation.** All reads currently hit the primary. Analytics queries will use MongoDB `readPreference: secondaryPreferred` (Atlas replica set) plus hard page and date-window limits.
5. **Atlas collection limit.** The cluster is at the collection cap. OAuth grants are stored in the existing `api_keys` collection (`kind: "oauth_grant"`, never matched by the API-key resolver) and authorisation codes in `mfa_pending`. **No new collections.**

## 3. Power BI facts that shape the design (external constraints)

| Fact | Consequence |
|---|---|
| Power BI's built-in Web/OData connectors can't do OAuth against a non-Microsoft service; they only support anonymous, basic, key or Microsoft accounts | A **custom Power Query connector** (`.mez`) is the only way to meet "no static secret" with refresh |
| Uncertified custom connectors load in Power BI Desktop only when the user enables *"Allow any extension to load without validation"*, or when the connector is signed and its thumbprint trusted | Ship unsigned for the pilot with clear instructions. Signing needs a code-signing certificate (≈ $200–500 a year), a later owner decision |
| Scheduled refresh in the Power BI **Service** with an uncertified connector needs an **on-premises data gateway** that the customer runs on an always-on Windows machine | Document it as a customer requirement. Microsoft certification (AppSource) removes it but takes months and isn't guaranteed |
| Power BI Desktop is free; publishing and scheduled refresh need Power BI Pro or Premium Per User licences, bought by the customer | Shown on the setup screen (SOW §11) |
| Power BI Project format (`.pbip`, TMDL + PBIR) is plain text | The starter semantic model and report pages can be generated and versioned in the repo |

## 4. Proposed design

- **OAuth 2.0 server**: `/api/analytics/oauth/authorize` (signed-in Enterprise owner/admin or an allowed member consents, picks the company), `/token` (code + PKCE; refresh rotation), `/revoke`. Access token: HMAC-signed, 60 minutes, carries the grant ID. **Every API call re-checks** that the grant is active, the person is still an active member, still entitled (Enterprise, licence, feature switch) and still has the role and branches. Refresh token: 90 days of inactivity, rotated on each use, revocable from Inaya.
- **Analytics API v1**: `GET /api/analytics/v1/datasets` (catalogue and data dictionary), `GET /api/analytics/v1/datasets/{name}?from&to&cursor&limit` returning JSON rows with a `next` cursor. Max 90-day window per request and 5,000 rows per page; quotas per company and per grant.
- **Datasets (proposed first release)**: Company and branches · Sales lines (POS) · Sales refunds · Online orders · Invoices · Payments · Expenses · Products · Stock balances · Stock movements · Purchase orders · Suppliers · Customers (ID, name, segment; no email or phone) · Work and repair orders · Workforce hours (aggregated per person per day) · Leave (aggregated) · Metadata.
- **Permissions**: Finance datasets need owner/admin or `financeRole`; HR datasets need owner/admin or `hrRole`; Sales/Commerce/Inventory need owner/admin or `commerceRole` manager/supervisor; branch-bearing datasets always pass through the member's branches; disabled modules return nothing.
- **Connector**: `Inaya.mez` (OAuth sign-in, company picker, navigation table of datasets, paging, date-range parameters for incremental refresh).
- **Starter content**: Power BI Project with the semantic model (relationships and measures: Gross sales, Net sales, Discounts, Returns, Tax, Expenses, Invoiced vs received, Receivables, Stock on hand, Orders by status, Job turnaround) and five report pages (Executive, Finance and Cash, Sales and Commerce, Inventory, Operations).
- **In Inaya**: Admin > Integrations > Power BI: what is shared, the licences and gateway needed, a connector download, connected users, last access, and Revoke.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Cross-company leakage | Company from the token only; adversarial isolation tests (SOW §14.3) |
| Branch or role bypass | Server-side filters per dataset; tests per role |
| Revoked user keeps access | 60-minute access tokens plus a grant/membership check on every call |
| Load on live database | Secondary reads, windows, page caps, quotas |
| Metrics disagree with Inaya | Same minor-unit definitions as Commerce reports; reconciliation tests |
| Uncertified-connector friction | Clear Desktop setting instructions; gateway guide; signing/certification as a later decision |

## 6. Not recommended

Direct database or SQL access · reusing static API keys for Power BI · real-time/DirectQuery (scheduled import only) · claiming Microsoft certification · publishing an availability SLA before it's measured.

## 7. Implementation batches (after approval)

1. OAuth server, grants and revocation, Enterprise gate and feature switch, admin screen.
2. Analytics API v1 with datasets, permissions, paging, incremental windows, quotas and audit; automated tests (isolation, branches, roles, revocation, reconciliation).
3. Power Query connector (`.mez`) and its build script.
4. Starter semantic model and report pages (`.pbip`).
5. Documentation (setup, refresh/gateway, data dictionary, metrics, admin, troubleshooting, support runbook).
6. Live acceptance: Power BI Desktop on a pilot machine, then Service refresh through a gateway with a pilot customer.
