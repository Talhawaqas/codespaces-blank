# Hospitality & Food Service Workspace: test report

Date: 2026-11-15.

## Results

| Suite | Result |
|---|---|
| `test/hospitality.test.mjs` (new): 13 pure-rule tests + 26 end-to-end tests on the real database | **39 of 39 pass** |
| `vertical-lock-wiring`, `engagement-marketing`, `engagement-calendar`, `education-os` (existing, touched by this work) | 148 of 148 pass |
| `navigation-launcher`, `workflow-unit`, `workflow-features` (existing) | 33 of 33 pass |
| Production build (`next build`) | Compiled; 473 pages generated |
| Workflow templates | The four Hospitality templates pass the engine's validator |

Run with: `node --env-file=.env.local --experimental-test-module-mocks --test-force-exit --test test/hospitality.test.mjs`. The database tests create a throwaway company, remove it by id at the end, and send no real email.

## Baseline before this work

The full `npm test` run already failed before any Hospitality change: about 553 failure lines, mostly 60-second timeouts and the NAS, S3, RDS and real-client suites that need outside services. None of those files were touched by this work. The full suite was not rerun afterwards; the suites that share code with this work were (table above).

## What the database tests cover (SOW 26)

- Reservation lifecycle and every refused transition; reschedule, table change, arrival, seating, completion, cancellation.
- **Simultaneous bookings:** four requests for the same table at once, exactly one wins, no stray table locks.
- **Capacity:** four simultaneous parties against a 12-guest limit; the limit is never exceeded; staff can override on purpose.
- Availability, last seating, lead time, horizon, closures; daylight-saving gaps (New York, March 2027).
- CRM: new guest creates a contact, the same email reuses it, phone-only matches go to manager review, visits and activity written to the contact.
- Waitlist, guest export and erase (including a guard against an empty id erasing other records).
- Public page: safe fields only, honeypot, idempotent repeat, staff-only fields ignored, company taken from the page not the request, token hashed, wrong tokens refused, cancel can't be replayed, page switched off.
- Reminders sent once.
- Menu: draft vs publish, allergen review before publishing, manager-only price and allergen changes with audit of old and new values.
- Recipes: unit conversion, versions, cost shown only when every ingredient has a price.
- Wastage approval by someone else, two simultaneous approvals reduce stock once; stock counts; reorder drafts a purchase request and creates no purchase order; delivery discrepancies.
- Roster: drafts hidden from staff, overlap warning, publish notifications, swaps.
- Checklists: one run per day under simultaneous starts, evidence required, overdue alert sent once.
- Incidents: visibility limited to managers and the people involved; notifications carry no details.
- Reports: "insufficient data" instead of zero; CSV formula injection neutralised.
- Campaign audience: opted-in guests only, unsubscribed guests excluded.
- AI tools: read-only, scoped by role and location, no contact details returned.
- **Isolation:** another company gets 404 on locations, reservations, waitlist, guests, wastage, shifts and incidents; a host limited to one location can't reach the other; a member with no hospitality role is refused.
- Audit chain entries for 23 critical actions, and the chain verifies.

## Defects found by these tests and fixed

1. A currency such as "rupees" was cut to "RUP" and accepted. Now refused.
2. Under simultaneous bookings, the guest limit check could wrongly report "fully booked" when two requests created the same slot counter. Now retried correctly.
3. Changing a party size kept a table that no longer fitted. Now a fitting table is chosen.
4. Guest profile, export and erase could reach any CRM contact; now only contacts who are guests at the caller's locations.

## Browser check (local dev server, throwaway company, removed afterwards)

Added a location, a seating area and a table; created a reservation (R-000001) on the Reservations tab; opened every tab with no console errors; booked through the public page (R-000002) and opened the guest's manage link. Two issues found and fixed: the Overview kept counts from when the page opened (now refreshes), and the public page said a confirmation email had been sent even when it hadn't (now only when the mail provider accepted it).

## Not tested

Live email delivery, the AI tools with a live model, workflows running end to end in the engine, phone layouts, and the HTTP rate limits under real traffic.
