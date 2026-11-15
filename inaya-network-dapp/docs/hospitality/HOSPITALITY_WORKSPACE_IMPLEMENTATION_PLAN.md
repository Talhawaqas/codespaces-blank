# Hospitality & Food Service Workspace: implementation plan and record

Date: 2026-11-14 to 2026-11-15. The SOW's phases were built in one round, in this order. Each phase lists what was delivered and how it was checked.

| Phase | Delivered | Checked by |
|---|---|---|
| 0. Discovery | `HOSPITALITY_WORKSPACE_REPOSITORY_AUDIT.md`; baseline test run and build | Baseline logs (see test report) |
| 1. Foundation | `hospitality` industry; roles and location scope (`store.js`); audit and workflow-event helpers; navigation, launcher, ERP tile, icon, business-type picker; overview | Pure permission tests; route wiring test |
| 2. Reservations and guests | Locations, hours, policy, seating (`locations.js`); lifecycle, slot locks, capacity counters, availability, floor, waitlist, CRM linking, duplicate review, export and erase, public page and manage link, reminders (`reservations.js`, `messages.js`, `/api/reserve/*`, `/reserve/*`) | Database tests including simultaneous bookings; browser check of setup, booking and the public page |
| 3. Menu and stock | Catalogue, modifiers, allergen review, availability suggestions, recipes with versions and cost coverage (`menu.js`); stock overview, wastage approval, counts, reorder hand-off, supplier preferences, delivery checks (`stock.js`) | Database tests; stock verified through `stock_levels` |
| 4. Daily operations | Roster, publishing, unavailability, HR leave, swaps; checklists with evidence and overdue alerts; incidents (`operations.js`) | Database tests |
| 5. Campaigns | Consent captured at booking; "guest visits" audience rule in the existing Campaigns module; no second sender | Database tests (opt-in only, unsubscribed excluded) |
| 6. AI, automation, reports | Eight read-only assistant tools; four workflow templates; reports with definitions and CSV export; integration status (`reports.js`, `ai-hospitality-tools.js`) | Database tests; templates validated against the workflow engine |
| 7. Pilot hardening | Product guide (`content/docs/products/hospitality-os.md`), these documents, roadmap stage 33 | Pilot interviews are still owed (see known limitations) |

## Deviations from the SOW, and why

| SOW | Deviation | Reason |
|---|---|---|
| 22, 23 | No new collections or migrations; records live in `calendar_records` with `h_*` kinds | Atlas is at its collection limit; founder ruling of 13 November |
| 23 | One catch-all route instead of `/api/orgs/:orgId/hospitality/...` paths | Same convention as Education OS; `orgId` is a parameter checked against the session |
| 8.4 | No visual floor-plan editor; tables are a list per area | SOW says a simple model first |
| 8.8 | Bot protection is a honeypot and rate limits, no CAPTCHA | No paid subscriptions |
| 10.2 | Modifiers are edited as structured text | Avoids a POS-style modifier engine (SOW 10.2) |
| 13 | Shifts use HR employees and leave, but no new HR fields | Reuse without changing HR |
| 15 | Private dining, catering and tastings are reservation types | Avoids a parallel calendar engine (SOW 15) |
| 16.2 | Templates notify and record; none sends to guests automatically | Consequential actions stay with people (SOW 16.3) |
| 28 | Pilot interviews not done | They need real restaurants |

## Next steps

1. Pilot with two or three restaurants (SOW 28) and adjust the reservation policy defaults, roles and checklists from what they say.
2. Finish the Resend marketing setup so campaign delivery can be verified.
3. Choose a POS for a read-only connector after the pilots; only then add sales-based stock deduction and food-cost reporting.
4. Mobile screens for hosts (today's reservations, floor, waitlist), shipped by OTA.
