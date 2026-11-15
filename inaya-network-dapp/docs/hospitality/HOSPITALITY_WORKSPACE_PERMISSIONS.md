# Hospitality & Food Service Workspace: permissions

Every check is made on the server, in `src/lib/hospitality/*`. Screens only hide what a role can't use.

## Gates, in order, on every members-only request

1. A valid session and active membership of the company (`requireMembership`). The company id in the request is never trusted on its own.
2. The company's industry is Hospitality (`requireVertical`).
3. The member is an owner, an admin, or holds a hospitality role.
4. The capability for that action (table below).
5. The location: the record's location must be one the member may use.

`orgId`, `membership` and `actorEmail` in a request body are discarded; they always come from the session.

## Roles

`hospitalityRole` on the member: `manager`, `host`, `service`, `kitchen`, `stock`. Owners and admins can do everything. Marketing and finance keep their existing roles (`marketingRole`, finance roles).

| Capability | Owner / admin | Manager | Host | Service | Kitchen | Stock |
|---|---|---|---|---|---|---|
| Locations, tables, policies, checklist templates | Yes | Yes | | | | |
| Read reservations, floor, waitlist | Yes | Yes | Yes | Yes | | |
| Create, change, cancel reservations; waitlist | Yes | Yes | Yes | | | |
| Mark arrived, seated, completed; record feedback | Yes | Yes | Yes | Yes | | |
| Guest contact details, staff notes, guest profile | Yes | Yes | Yes | | | |
| Export or erase a guest's data; review possible duplicates | Yes | Yes | | | | |
| Read the menu | Yes | Yes | Yes | Yes | Yes | Yes |
| Draft menu items and recipes; switch items on or off | Yes | Yes | | | Yes | |
| Publish items; change a published price or allergen information | Yes | Yes | | | | |
| Read stock; record wastage; count stock; record a delivery check | Yes | Yes | | | Yes | Yes |
| Draft a purchase request; supplier preferences; resolve a delivery issue | Yes | Yes | | | | Yes |
| Approve wastage or a stock count (never your own) | Yes | Yes | | | | |
| See the published roster; mark yourself unavailable; ask to swap your shift | Yes | Yes | Yes | Yes | Yes | Yes |
| Edit and publish the roster; decide swaps | Yes | Yes | | | | |
| Run checklists; raise an incident | Yes | Yes | Yes | Yes | Yes | Yes |
| See all incidents; assign them | Yes | Yes | | | | |
| Reports and CSV export | Yes | Yes | | | | |
| Change hospitality roles and location access | Yes | | | | | |

## Record-level rules

- **Service staff** see a reservation's guest name, party size, time, table, occasion and request. They don't get email, phone, staff notes or history.
- **Incidents:** people who aren't managers see only incidents they raised or were assigned. Opening a guest complaint or safety incident is written to the audit chain. Notifications name the kind of incident, never the detail.
- **Four-eyes:** nobody approves wastage they recorded or a stock count they did.
- **Roster:** staff see published shifts only; drafts are the manager's.

## Location scope

A member's allowed locations are `hospitalityLocationIds`. With a single location, no list is needed. As soon as a company has two or more, a member with no list reaches none of them: access must be given explicitly by the owner or an admin. A record outside the member's locations returns 404, the same as a record that doesn't exist.

## Other companies

Every query carries the caller's `orgId`. A valid id from another company returns 404 for reads and writes. This is covered by tests for locations, reservations, waitlist, guests, wastage, shifts and incidents.

## Public endpoints

No session. They can read one location's public details and free times, create one reservation, and view, cancel or leave feedback on a reservation with its token. Staff-only fields in a public request are ignored. Rate limits: 240 views, 8 booking attempts per IP and 4 per email, per hour; 120 views and 20 actions per hour on manage links.

## Audit

Written to the existing hash chain with the actor, time, action and (where it matters) old and new values: location and seating changes, reservation create, change, table assignment and every status; guest link after review, profile change, export, erase; menu create and update, price change, allergen change, availability; recipes; wastage record and decision; stock count; reorder draft; delivery check and resolution; shifts, roster publish, swaps; checklist completion; incidents; role changes; stock rules; report export.
