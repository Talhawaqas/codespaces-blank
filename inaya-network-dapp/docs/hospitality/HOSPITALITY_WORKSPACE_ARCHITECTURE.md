# Hospitality & Food Service Workspace: architecture

Date: 2026-11-14. Describes what is built. Status of each feature is in `HOSPITALITY_WORKSPACE_KNOWN_LIMITATIONS.md`.

## Shape

Hospitality OS is the eighth industry mode of the Business Workspace (`vertical: "hospitality"`). It adds restaurant workflows and reuses the existing modules for everything else.

| Layer | Where |
|---|---|
| Server logic | `src/lib/hospitality/` : `store`, `locations`, `reservations`, `messages`, `menu`, `stock`, `operations`, `reports` |
| Members-only API | `src/app/api/orgs/hospitality/[[...path]]/route.js` (one catch-all) |
| Public API | `src/app/api/reserve/[slug]/route.js`, `src/app/api/reserve/manage/[token]/route.js` |
| Screens | `src/components/business/HospitalityView.js` + `hospitality/{shared,Back,Admin}.js` |
| Public pages | `src/app/reserve/[slug]/page.js`, `src/app/reserve/manage/[token]/page.js` |
| AI tools | `src/lib/ai-hospitality-tools.js`, wired in `ai-os-router.js` |
| Workflow templates | four "Hospitality" templates in `src/lib/workflows/templates.js` |
| Background work | reservation reminders and overdue-checklist alerts run inside the existing `/api/cron/engagement` job |

## What is reused, not copied

| Need | Existing module used |
|---|---|
| Guests | CRM contacts (`crm_contacts`). A reservation stores `contactId`; visits are written back as `hospitality.visits`, `hospitality.lastVisitAt` and a CRM activity |
| Ingredients and stock | Inventory products, stock levels, lots. Every quantity change goes through `recordStockMovement()` |
| Reorder | `draftReorderRequest()` creates a draft purchase request, which then follows the existing approval flow |
| Receiving into stock, purchase orders, suppliers | Procurement (unchanged). Hospitality adds a delivery-check record beside the purchase order |
| Staff | HR employees and approved leave (read-only) |
| Campaigns, consent, unsubscribe | Campaigns module (`engagement/*`). One new audience rule, "guest visits" |
| Automations | Existing workflow engine; hospitality raises events |
| Audit | Existing hash chain (`appendAuditEntry`), record types prefixed `HOSPITALITY_` |
| Notifications, email, rate limits | Existing helpers |

## Storage

Atlas is at its collection limit, so no collection was added. Every hospitality record is a document in the existing `calendar_records` collection with an `h_*` kind and an `orgId`:

`h_settings`, `h_location`, `h_area`, `h_table`, `h_reservation`, `h_lock`, `h_cap`, `h_waitlist`, `h_counter`, `h_menu`, `h_category`, `h_item`, `h_wastage`, `h_count`, `h_receiving`, `h_supplier_pref`, `h_shift`, `h_unavailable`, `h_checklist_tpl`, `h_checklist_run`, `h_incident`.

Every query filters on `{ orgId, kind }`. Marketing consent stays in `marketing_records`. Indexes are created by `ensureHospitalityIndexes()` and are partial (per kind), so they don't touch appointment documents.

A location is not a warehouse. A location may point to one warehouse (`warehouseId`); stock screens need that link.

## Booking integrity

No multi-document transactions are used. Two unique indexes do the work:

1. **Tables.** Reservations sit on a 15-minute grid. A table is held by one `h_lock` document per table per 15-minute slot, under a unique index on `{ orgId, kind, lockKey }`. Two simultaneous bookings of the same table can't both insert their locks; the loser's partial locks are removed and it gets a 409.
2. **Capacity.** Guests per location per slot are counted in `h_cap` documents. Each slot is claimed with a conditional `$inc` that only matches while the new total stays within `maxCoversPerSlot`; a failed claim rolls back the slots already claimed.

Order of operations in `book()`: capacity, then tables, then the reservation document. Any failure releases what was claimed. Rescheduling claims the new slots before releasing the old ones. Status changes are guarded on the current status, so two people acting at once can't both win. Public bookings carry an idempotency key under a unique index, so a retry returns the first booking.

## Reservation lifecycle

`REQUESTED → PENDING_CONFIRMATION → CONFIRMED → ARRIVED → SEATED → COMPLETED`, with `CANCELLED`, `NO_SHOW` and `DECLINED` as end states. Transitions are validated on the server. A no-show can't be recorded before the grace period ends. Ending a reservation releases its table locks.

## Time, currency, locale

- Each location stores an IANA time zone and a currency. Instants are stored in UTC; each reservation also stores its local `date` and `time`.
- Slots are generated in the location's zone. A wall-clock time skipped by a daylight-saving change is not offered.
- Menu prices are integers in minor units with an explicit currency. Nothing is hardcoded to PKR or USD.

## Public surface

`/api/reserve/[slug]` returns only business name, location name, address, phone, hours, public policy text and free times, and creates one reservation. It's rate-limited per IP and per email, has a honeypot field, caps request size, and ignores staff-only fields. The manage link is a random token; only its SHA-256 hash is stored, and it stops working a week after the visit.

## AI

Eight read-only tools. They call the same functions as the screens with the caller's membership, never return guest email addresses, phone numbers or private notes, and can't change anything. Guest-written text is passed as quoted data, and the system instruction tells the model not to treat it as instructions.
