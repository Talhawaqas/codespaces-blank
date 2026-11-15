# Hospitality & Food Service Workspace: integrations

The Integrations panel (Hospitality > Settings > Integrations) reports each integration with one of five states. Nothing is shown as connected unless the other system has confirmed it.

| Integration | State shown | Basis |
|---|---|---|
| Reservation emails (confirmation, change, cancellation, reminder, waitlist invite) | Configured, not verified (when a mail provider key is set) | Sent through the existing transactional email helper. Each reservation records "handed to the mail provider" or "failed"; that isn't proof of delivery |
| Campaign email provider (Resend) | Connected and verified only when a sender is configured, the webhook secret is set and the provider has confirmed at least one delivery for this company; otherwise Configured, not verified, or Available | Reuses the Campaigns module. The marketing subdomain DNS, webhook and secret still have to be set up by the founder |
| Text reminders (Twilio) | Available (not configured) | No paid subscription. Reminders go by email |
| Calendar feed (ICS) | Available | Staff calendars in Appointments. Reservations are not pushed to external calendars |
| Google Calendar / Outlook two-way sync | Planned | Not built. Sync direction, conflict ownership, cancellation and duplicate handling must be agreed first |
| POS sales and order events | Planned | No POS connector exists. Until one does: stock isn't deducted from sales, and food cost and sales reports aren't calculated |
| Deposits and card payments | Planned | Not built. Card details are never stored |
| External accounting platforms | Planned | Supplier bills go to Finance and the AI Bookkeeper inside the workspace |
| Food-delivery marketplaces | Not supported | Out of scope (SOW 4.2) |

## Requirements a future connector must meet (SOW 19.5)

These already exist in the platform and must be used, not rebuilt: encrypted server-side credentials (`integrationCrypto.js`), OAuth with rotation (`integrationOauth.js`), signed webhooks with replay protection (`src/lib/webhooks/`), rate limits (`rateLimit.js`), per-company authorization, and the audit chain for configuration changes. A POS connector should start read-only (sales summaries, item sales, completed transactions) and be chosen after pilot interviews, not before.

## Outbound

Hospitality raises workflow events (list in `HOSPITALITY_WORKSPACE_API.md`). A company can forward them to its own systems with the existing Webhooks feature. Payloads carry ids, counts and statuses, never guest contact details.
