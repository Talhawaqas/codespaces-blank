# Business Workspace License — Data Model

No new collections (Atlas limit). Everything lives in two existing collections.

## `org_subscriptions` — the license (one document per company)

Unique index `license_org_unique` on `orgId`. License fields:

| Field | Meaning |
|---|---|
| `licenseId` | `lic_…`; present only on real licenses |
| `licenseStatus` | `pending_activation`, `active`, `grace_period`, `suspended`, `cancelled`, `expired` (stored); access uses `effectiveState()` |
| `planId`, `planSnapshot` | package id and a snapshot (name, limits, list prices) taken at assignment / change |
| `billingCycle` | `monthly` / `yearly` |
| `currency`, `amount` | agreed amount per period (`USD` or `PKR`) |
| `anchorDay` | original billing day (1–31) |
| `startDate` | first period start (billing date, PKT) |
| `paidThroughDate`, `nextPaymentDueDate` | billing dates (YYYY-MM-DD, PKT); they are equal |
| `paymentDueAt` | UTC instant the payment becomes overdue (end of the due date in PKT) |
| `graceStartedAt`, `graceEndsAt`, `graceExtensionDays` | grace window; `graceEndsAt = paymentDueAt + 14 days + extensions` |
| `suspendedAt`, `suspendedReason` | `grace_ended` (job) or `manual` |
| `overrideUntil`, `overrideReason` | admin override (access without payment, ≤ 30 days) |
| `cancelledAt`, `cancelEffectiveAt`, `cancelReason` | cancellation |
| `pendingChange` | plan / cycle / amount to apply at the next renewal |
| `currentSubscriptionId` | the current `license_period` row |
| `lastPaymentAt`, `lastPaymentMethod`, `lastRenewalPaymentId`, `previousPaidThroughDate` | payment summary |
| `needsReview` | set when a non-latest payment is reversed |
| `notes[]` | internal admin notes (never shown to the company, never exported) |
| `licenseVersion` | optimistic-concurrency counter; every change is conditional on it |
| `createdAt/By`, `updatedAt/By` | attribution |
| `plan`, `status`, `currentPeriodEnd`, `billingInterval`, `provider` | older fields kept in sync for existing readers |

Indexes: `license_status_due` (`licenseStatus`, `paymentDueAt`), `license_status_grace` (`licenseStatus`, `graceEndsAt`), both partial on `licenseId`.

## `billing_requests` — append-only license history (`kind` field)

Activation requests (no `kind`) are unchanged; `listBillingRequests` reads only rows without `kind`.

| `kind` | Rows | Key fields |
|---|---|---|
| `license_period` | one per subscription version | `version`, `planSnapshot`, `billingCycle`, `amount`, `currency`, `periodStartDate`, `periodEndDate`, `paymentDueAt`, `periodStatus` (`awaiting_payment`, `paid`, `plan_change`, `superseded`), `changeReason`, `paymentId` |
| `license_payment` | one per payment, plus one per reversal | `amount`, `currency`, `method` (`nayapay`, `bank_transfer`, `other_manual`), `reference`, `receivedAt`, `periods`, `paymentStatus` (`pending`, `confirmed`, `rejected`, `reversed`, `reversal`), `confirmedAt/By`, `renewal{from,to}`, `reversalOf`/`reversalId`, `idempotencyKey` |
| `license_event` | immutable audit | `eventType`, `actorType` (`admin`, `system`, `company_user`), `actorId`, `at`, `previousState`, `newState`, `previousValues`, `newValues`, `reason`, `source`, `correlationId`, `metadata` |
| `license_notice` | one per notice per billing period | `noticeType`, `dedupeKey` (unique), `noticeStatus` (`sending`, `sent`, `failed`, `no_recipients`), `attempts`, `recipients[]` |
| `company_export` | export jobs | `exportStatus` (`queued`, `running`, `ready`, `failed`, `expired`), `requestedBy/At`, `startedAt`, `completedAt`, `expiresAt`, `artifact` (internal storage reference, never a URL), `bytes`, `records`, `filesIncluded`, `errorCode`, `errorMessageSafe`, `downloadedAt/By` |

Indexes (partial on `kind`): `ledger_kind_org_time`, unique `ledger_idempotency`, unique `ledger_notice_dedupe`, `ledger_payments`, `ledger_exports`.

Multi-document changes (confirm payment, reversal, assignment, plan change) run in one MongoDB transaction.
