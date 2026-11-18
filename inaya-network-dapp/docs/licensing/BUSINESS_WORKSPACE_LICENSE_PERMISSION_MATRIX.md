# Business Workspace License — Permission Matrix

## Company side (enforced on the server in `src/lib/licensing/gate.js`)

| Capability | Active / grace / override | Suspended / cancelled (after end) / expired |
|---|---|---|
| Normal Workspace APIs (CRM, finance, documents, AI, …) | Members per existing roles | Refused (403 `LICENSE_RESTRICTED`) |
| Session, company list, sign-out | Everyone | Everyone |
| License status notice (`/api/orgs/license/status`) | Everyone (members: neutral notice only) | Everyone (members: neutral notice only) |
| Billing, license details, payment history (`/api/orgs/billing*`, `/api/orgs/license*`) | Owner/Admin | Owner/Admin |
| Company data export (`/api/orgs/exports*`, `/api/orgs/export-zip`) | Owner/Admin | Owner/Admin |
| Read-only document download (`GET /api/orgs/documents/:id/retrieve`) | Per document permissions | Owner/Admin |
| Help & Support (`/api/help/*`) | Everyone | Everyone |
| Uploads, edits, deletes, member administration | Per existing roles | Refused |
| API keys, S3/Azure/GCS keys, share links, portal, file requests, booking, meeting links, data rooms, gateways, identity API, webhooks | Per existing rules | Refused |
| Automations (workflows, webhooks, AI actions, reminders, campaigns, document jobs, reorder) | Run | Paused |
| Backups, retention, revocations, purges | Run | Run (data protection) |
| Inbound support e-mail | Received | Received and kept (nothing lost); nothing served |

The license gate is an additional check: department, project, record and role permissions still apply.

## Inaya side
| Action | Who |
|---|---|
| View / assign / change / record & confirm payments / suspend / reactivate / cancel / export reports | Admin portal session (the founder is the only admin, 17 Nov 2026). Actions are recorded as `LICENSE_ADMIN_NAME`. |
| License transitions by the job | `license-job` (system), only grace start and suspension |
| Company data access | Not granted by license management (existing support policy) |

No company user can change a license, confirm a payment or bypass suspension.

## Routes deliberately open while restricted (with reason)
See `JUSTIFIED` in `scripts/sqa/license-route-coverage.mjs`: session/sign-in/sign-out, MFA status, pending approvals, create company, Help & Support, Stripe webhook (retired card checkout), product feedback, inbound support e-mail, dApp wallet storage keys (not Business Workspace).
