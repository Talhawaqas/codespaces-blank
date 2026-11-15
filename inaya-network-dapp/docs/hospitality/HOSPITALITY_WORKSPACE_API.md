# Hospitality & Food Service Workspace: API

All members-only routes are under `/api/orgs/hospitality/...` and need a signed-in session, membership of `orgId`, the Hospitality industry on that company, and a hospitality role (or owner/admin). `orgId` is a query parameter on GET and a body field otherwise. Errors are `{ "error": "..." }` with a matching HTTP status: 400 invalid input, 403 not allowed, 404 not found or out of scope, 409 conflict. CRM, Inventory, Procurement, HR, Campaigns and Workflows keep their own API namespaces.

## Members-only

| Method and path | What it does |
|---|---|
| `GET overview?locationId` | Today's cards for the caller's role, plus locations and capabilities |
| `GET options` | Roles, statuses, transitions, sources, reasons, default policy |
| `GET locations` · `POST locations` · `PATCH locations/{id}` | Locations: name, time zone, currency, hours, closures, policy, web address, linked stock location |
| `GET warehouses` | Stock locations a manager can link |
| `GET locations/{id}/seating` · `POST locations/{id}/areas` · `POST locations/{id}/tables` · `DELETE locations/{id}/areas\|tables/{id}` | Seating areas and tables |
| `GET locations/{id}/availability?date&partySize` | Free times for a date and party size |
| `GET locations/{id}/floor?at` | Every table's state now and next, and reservations without a table |
| `GET reservations?locationId&from&to&status&tableId&areaId&q&page&limit` | List (at most 62 days, 500 rows a page) |
| `POST reservations` | Create. Body: `locationId, name, email, phone, partySize, date, time, source, type, tableIds, areaId, occasion, guestNote, internalNote, marketingConsent, idempotencyKey, override` |
| `GET reservations/{id}` · `PATCH reservations/{id}` | Read; change time, party, tables or notes |
| `POST reservations/{id}/transition` | `{ toStatus, reason, outcome, servedByEmail }` |
| `POST reservations/{id}/feedback` | `{ rating 1-5, comment }` after completion |
| `GET waitlist?locationId` · `POST waitlist` · `GET waitlist/next?locationId` · `POST waitlist/{id}` | Waitlist; action is `invite`, `seat`, `cancel` or `expire` |
| `GET guests?q` · `GET guests/{contactId}` · `PATCH guests/{contactId}` | Guest directory, history, preferences |
| `GET guests/duplicates` · `POST guests/duplicates/{reservationId}` | Review a possible match: `{ contactId }` to link, `null` to keep separate |
| `GET guests/{contactId}/export` · `POST guests/{contactId}/erase` | Manager only. Erase needs `{ confirm: "ERASE", reason }` |
| `GET menu?locationId` · `POST menu/menus` · `POST menu/categories` · `POST menu/items` · `PATCH menu/items/{id}` | Catalogue |
| `POST menu/items/{id}/availability` | `{ available, reason }` |
| `GET menu/items/{id}/recipe` · `PUT menu/items/{id}/recipe` | Recipe with stock on hand and estimated cost; save `{ recipe }` or `null` to remove |
| `GET menu/ingredients?q` · `GET menu/suggestions` | Ingredient picker; items to consider switching off |
| `GET stock?locationId&q&lowOnly` | Stock at the location with reorder suggestions |
| `POST stock/reorder` | `{ locationId, productId }` drafts a purchase request |
| `PUT stock/suppliers` · `PUT stock/settings` · `GET stock/purchase-orders` | Supplier preference; approval rules; recent orders |
| `GET stock/wastage` · `POST stock/wastage` · `POST stock/wastage/{id}/decide` | Wastage and approval |
| `GET stock/counts` · `POST stock/counts` · `POST stock/counts/{id}/decide` | Stock counts and approval |
| `GET stock/receiving` · `POST stock/receiving` · `POST stock/receiving/{id}/resolve` | Delivery checks and discrepancies |
| `GET roster?locationId&weekStart` · `POST roster/shifts` · `PATCH\|DELETE roster/shifts/{id}` · `POST roster/publish` · `PUT roster/unavailable` | Roster |
| `POST roster/shifts/{id}/swap` · `POST roster/shifts/{id}/swap/decide` | Shift swap request and decision |
| `GET checklists?locationId&date` · `POST checklists/templates` · `POST checklists/runs` · `PATCH checklists/runs/{id}` | Checklists |
| `GET incidents?locationId&status` · `POST incidents` · `GET\|PATCH incidents/{id}` | Incidents |
| `GET reports?locationId&from&to&format=csv` | Reports (JSON or CSV); the CSV export is audited |
| `GET integrations` | Integration status |
| `GET staff-roles` · `PUT staff-roles` | `{ email, hospitalityRole, locationIds }`, owner or admin only |

## Public

| Method and path | What it does |
|---|---|
| `GET /api/reserve/{slug}` | Business and location name, address, phone, hours, public policy |
| `GET /api/reserve/{slug}?date&partySize` | Free times |
| `POST /api/reserve/{slug}` | `{ name, email, phone, partySize, date, time, occasion, note, marketingConsent, idempotencyKey }` → `{ ref, status, manageToken }` |
| `GET /api/reserve/manage/{token}` | The guest's reservation |
| `POST /api/reserve/manage/{token}` | `{ action: "cancel" }` or `{ action: "feedback", rating, comment }` |

Rate limits return 429. An unavailable time returns 409 with up to four `alternatives`.

## Workflow events

Raised as `event` triggers with ids and non-personal fields only: `reservation.created`, `.changed`, `.confirmed`, `.arrived`, `.seated`, `.completed`, `.cancelled`, `.no_show`, `.declined`, `waitlist.created`, `table.available`, `feedback.submitted`, `menu.item_unavailable`, `menu.item_available`, `wastage.recorded`, `delivery.discrepancy`, `shift.published`, `shift.changed`, `checklist.completed`, `checklist.overdue`, `incident.created`, `incident.escalated`.
