# Inaya Connect — release notes (build 1, hidden)

Feature flag `FEATURE_INAYA_CONNECT` (Business + Enterprise). Hidden: switched on only by an explicit per-company grant
(License Manager). `FEATURE_INAYA_CONNECT=off` in the environment is a kill switch.

## What ships
- **Connection (manual):** Phone number ID, WABA ID, App secret, System User token. Token checked with Meta before saving;
  secrets encrypted (INTEGRATION_ENCRYPTION_KEY), never returned. One company per number. Verify token shown once
  (stored hashed), rotatable without pausing a live number. Disconnect wipes secrets and frees the number.
- **Webhook** `POST/GET /api/connect/whatsapp`: tenant resolved only from `phone_number_id`; HMAC-SHA256 signature with
  that company's app secret; unknown/inactive numbers and bad signatures rejected and logged; messages stored once per
  WhatsApp id; replies produced after the 200 response; cron `/api/cron/connect` (every 5 min) retries anything pending
  (lease + max 3 attempts).
- **Pipeline:** STOP/START opt-out, per-sender hourly limit, staff phone linking (`LINK 123456` from a code made in the
  signed-in app), documents, business assistant (staff), customer assistant (optional), hand-over to people,
  after-hours message.
- **Business assistant:** read-only Business AI tools + sales summary, stock at my branches, job status, orders waiting
  dispatch, today's rota. Scoped to the member's permissions and branches. No approvals/payments/changes.
- **Customer assistant (off by default):** help articles always; own orders/repairs/appointments/invoices only after a
  6-digit code sent to the CRM email (10 min, 5 attempts, single use, 30-minute verified session). Complaints,
  payments, disputes → a person.
- **AI safety:** every request through the AI security gateway (rate limit, approved model, injection screening, output
  PII redaction); WhatsApp text wrapped as untrusted.
- **Inbox:** conversations, reply (24-hour rule enforced), take over / resume AI, assign, internal notes, close/reopen,
  create a support desk ticket (new channel `WHATSAPP`).
- **Documents:** only linked staff and allow-listed suppliers; file policy + signature + malware scan; de-duplicated by
  hash; bills → AI Bookkeeper drafts (never approved or paid); others → review queue (encrypted store); quarantine for
  everything else.
- **Usage & activity:** monthly in/out/billable counts, monthly send limit, cost ESTIMATE (Meta's invoice is
  authoritative); events without message content, numbers masked.

## Storage
No new collections: `calendar_records` kinds `wa_*`; one new global unique partial index `wa_key`.

## Tests
`test/inaya-connect.test.mjs` — 10 groups, fake Meta transport, scripted model, in-memory file store, test DB only.

## Owner steps before live tests
1. Grant FEATURE_INAYA_CONNECT to the founder company (License Manager).
2. Inaya Connect › Connection: enter the IDs, App secret and a permanent System User token.
3. Meta app › WhatsApp › Configuration › Webhook: callback URL + verify token from the Inaya screen; subscribe `messages`.
4. Business verification waits for incorporation (March); until then the Meta test number and up to 5 registered
   recipients are the limit.
