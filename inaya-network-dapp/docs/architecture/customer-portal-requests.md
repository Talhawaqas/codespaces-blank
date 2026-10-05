# Customer portal requests

Code: `src/lib/support/portalRequests.js`, customer API through `portalApi.js` and `src/app/api/portal/[slug]/request-files/`, staff API `src/app/api/orgs/portal-requests/`, screens `PortalTodo.js` (customer, "To do") and `PortalRequestsView.js` (staff, "Customer Requests"). It extends the existing customer portal, which already provides portal sign-in (magic link bound to one organization), notifications, and scanned, encrypted attachment storage.

## What a request is

A staff member asks **one** customer for a set of items. Each item is one of:

| Item | Customer does | Controls |
|---|---|---|
| upload | sends files | accepted types, maximum files, 4 MB each, policy checks and malware scan, stored encrypted |
| download | collects a file staff released | only the addressed customer, only through this request |
| form | completes a secure form | answers validated field by field (text, long text, choice, checkbox, date, e-mail, number); stored encrypted at rest; submitted once |
| agreement | accepts an NDA or policy | the exact text is hashed; acceptance records the typed name, time, the hash and a masked address; the text cannot change under the customer (a changed text is refused) |

A request is OPEN, IN PROGRESS, COMPLETE (every **required** item done; optional items do not block) or CANCELLED. A complete or cancelled request accepts no further changes. It has a note thread and a history; the customer sees "Staff" rather than a colleague's address.

## Isolation

* The organization comes from the portal address, and the customer session is for that organization.
* Every call checks the request is addressed to the signed-in customer's own e-mail address. Another customer, another portal and another organization's staff get "not found".
* A portal customer never becomes an organization member.
* Staff access needs a support role (agent or manager) or the helpdesk administrator role.

## Privacy and audit

Form answers are encrypted at rest; a staff member reading them is recorded. Every upload, download, form submission and acceptance is in the audit chain. Notifications to staff use the existing support notifications; customers are told by portal notification and e-mail.

## Limits

* Single-request uploads up to 4 MB per file. Larger files continue to use ticket attachments (chunked, up to 25 MB).
* A request finishes as soon as each required upload item has at least one file; ask for more files with a new request.
* Customer SSO and real antivirus remain as described in the Customer Portal documentation (not verified live).
