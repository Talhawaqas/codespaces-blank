# Hospitality & Food Service Workspace: status and known limitations

Date: 2026-11-14. Status labels: **Verified** (built and covered by passing tests) · **Built, not externally verified** · **Partial** · **Planned** · **Not built**.

## Status by SOW section

| SOW | Feature | Status |
|---|---|---|
| 5 | Repository audit | Verified (document) |
| 6 | Navigation, industry mode, overview | Verified. Screens compile in the production build; they have not been clicked through in a browser by a person yet |
| 7 | Locations, hours, closures, policies, location scope | Verified |
| 8.1–8.5 | Reservation lifecycle, calendar (day, week, month list), tables, availability, conflict and capacity prevention | Verified, including simultaneous-request tests |
| 8.6 | Waitlist | Verified. Wait times are only what staff quote; none is calculated |
| 8.7 | Arrival, seating, completion, feedback, CRM visit | Verified |
| 8.8 | Public booking page and manage link | Verified at the function level. The HTTP rate limits are in the routes and checked by a wiring test, not by a live request test |
| 9 | Guest profiles on CRM contacts, duplicate review, export, erase | Verified |
| 10 | Menu, categories, modifiers, allergens, availability, recipes with versions | Verified. Modifiers are edited as structured text, not a visual builder |
| 11 | Stock overview, counts, wastage with approval, reorder suggestions | Verified |
| 12 | Supplier preferences, delivery check and discrepancies | Verified. Receiving goods into stock stays in Procurement |
| 13 | Shifts, swaps, unavailability, checklists, incidents | Verified |
| 14 | Campaigns | Reused. New "guest visits" audience rule: Verified. Provider delivery events: Built, not externally verified (Resend marketing setup is still owed) |
| 15 | Events (private dining, catering, tasting, consultation) | Partial: they are reservation types that can hold a whole area. Staff meetings are not a type; use shifts or Appointments |
| 16 | Workflow events and four templates | Built. Events are raised and the templates validate against the single-trigger rule; they have not been run end to end in the engine |
| 17 | AI assistant tools | Verified for permissions and data shape. Not tested with a live model |
| 18 | Overview and reports with definitions and "insufficient data" | Verified |
| 19 | Integration status | Verified. POS, calendar sync, payments, accounting: Planned |
| 20 | Permissions, isolation, audit | Verified |
| 21 | Desktop, tablet and mobile layouts | Built with the workspace's responsive classes; not visually checked on a phone. No native mobile screens |
| 24 | Notifications | Verified in-app. Email: Built, not externally verified (no real email is sent in tests) |
| 25 | Time zones, daylight saving, currency | Verified |
| 28 | Pilot interviews | Not done. They need real restaurants and are owed by the founder |

## Limitations to know

1. **No POS.** Stock is never deducted from sales. Food cost is shown only as an estimate per recipe, and only when every ingredient has a purchase price; otherwise it says there isn't enough data. No sales figures appear anywhere.
2. **One collection.** All hospitality records share `calendar_records` because the database is at its collection limit. It works and is indexed, but a very busy group would be better served by dedicated collections after an Atlas upgrade.
3. **Menu is company-wide.** Items can be limited to locations, but any kitchen role can edit any draft item. Menus are not versioned per location.
4. **Stock roles see all products** in the company, not only those in their department, because ingredients aren't tied to a location beyond the linked stock location.
5. **Table model is simple.** Automatic assignment picks the smallest table or one combinable pair. There is no drag-and-drop floor plan and no optimisation.
6. **Capacity counters keep past slots** when a booking is completed early; only future slots are released. Reports are computed from reservations, not from the counters.
7. **Changed and reminder emails carry no manage link.** The link is in the first confirmation only, because only a hash of it is stored.
8. **Bot protection** is a honeypot field plus rate limits, not a CAPTCHA.
9. **Evidence attachments** on checklists and menu images accept a document id; the id isn't checked against the document store.
10. **Erasing a guest** removes their details from reservations and waitlist entries. The CRM contact itself is deleted in CRM, and audit entries are kept.
11. **No legal or compliance claims.** Consent is recorded and unsubscribes are honoured, but compliance with any country's marketing or data law is the restaurant's responsibility. Allergen information is the restaurant's own.
12. **Marketing email limits** depend on the Resend plan, which is still the free tier.

## Decisions taken without asking (from earlier rulings)

- New industry "Hospitality OS", same pattern as Education OS.
- No new database collection.
- Roles: manager, host, service, kitchen, stock.
- Nothing from SOW 4.2 was built (POS, payments, KDS, payroll, loyalty, marketplace).
