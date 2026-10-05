# Secure Sharing 2.0 — model and honest limits

Scope: Competitive Expansion SOW workstream B (share types, share management, file requests, file locks). Behind `FEATURE_ADVANCED_SHARING`.
Code: `src/lib/sharing/{policy,shares}.js`, `src/lib/net/cidr.js`, routes under `/api/orgs/shares/**` and `/api/orgs/share/[token]/**`.

## Why links changed from "pointers" to "ciphertext through Inaya"

Organization documents are encrypted on the owner's device with a passkey Inaya never holds. The original share link returned the
storage pointers (CIDs) and the recipient fetched the encrypted pieces straight from public IPFS gateways. That cannot support a
password, an IP limit, a download limit or instant revocation, because once a pointer is handed out Inaya no longer sees the fetch.

A Sharing 2.0 link therefore never hands out a pointer. The recipient opens the link, satisfies the rules, receives a short-lived
**access session**, and the encrypted pieces are served **through Inaya**, one fetch at a time, with every rule re-checked. Zero
knowledge is unchanged: Inaya only ever handles ciphertext and still cannot read the document. The recipient still needs the passkey
from the owner, out of band, to decrypt in their browser.

Old links keep working exactly as before. They are marked `v` absent; Sharing 2.0 links are `v: 2`. The old code path refuses `v: 2`
links outright (409) so it can never be used to skip a policy (tested).

## Rules a v2 link can carry

| Rule | Behaviour |
|---|---|
| Expiry | Required; one-year maximum; checked on opening **and on every content fetch** |
| Max uses / one-time | Counted atomically when a session is opened; exact under concurrency |
| Download limit (`download` links) | Reserved atomically on a session's first content fetch; exact under concurrency; view-only links never count downloads |
| Password | 8–128 chars, scrypt with a per-link salt, sent only in a POST body (never a URL), 8 wrong guesses lock the link for 15 minutes (even the right password is refused while locked) |
| IP / CIDR allow-list | IPv4 and IPv6; a session cannot be replayed from another network; failure looks identical to the device rule |
| Device binding (`first-use`) | The first device that opens it binds the link; others are refused |
| Email-domain restriction | Visitor enters an address in an allowed domain, receives a one-time 6-digit code by email (10 minutes, 5 attempts, single use). The answer is the same for an ineligible address, and nothing is sent to it. Needs the email provider configured; otherwise the visitor is told delivery is not available |
| Notify on access | In-app notification to the link creator when it is opened |
| Watermark | The viewer stamps "label \| visitor \| masked IP \| time" |
| Revocation | Immediate for new visitors **and** for sessions already open |
| Delegated managers | The creator can name up to 10 people who may update or revoke the link; a delegate cannot widen the delegation |

Responses to a failed location/device rule are deliberately one generic message so the answer does not reveal which rule failed.

## Sharing with a person (not a link)

`createMemberShare` writes an ordinary explicit document grant (`document_permissions`) with an optional `expiresAt`. The permission
resolver now ignores a grant whose `expiresAt` has passed; grants created before this feature have no `expiresAt` and are unaffected.

## The share manager

`GET /api/orgs/shares?scope=byMe|withMe|org|document&status=…` (paginated, newest first). `byMe` includes links you created or
manage. `org` is owner/admin only. `withMe` lists explicit grants others made to you. Tokens and password hashes are never returned.
Each link has an access log (`file_share_access_events`: masked IP, optional email, event type) kept 400 days.

## What this does NOT guarantee (say this to customers)

* **View-only is a viewer mode, not a prevention.** A visitor who has the passkey can decrypt what they were allowed to fetch. View-only
  stops the page offering a download and stops counting downloads; it cannot stop a determined person copying what is on their screen.
  See `docs/architecture/drm-viewer-security.md`.
* **Revocation stops all further fetches** but cannot recall bytes already downloaded or a passkey already given.
* **A passkey shared out of band is outside Inaya's control.** A link password protects the link; it is not the document key.
* IP allow-lists depend on the platform's forwarded client address (Vercel overwrites it; see `rateLimit.getClientIp`).
* Email-domain restriction proves control of a mailbox in that domain, not the identity of a person.

## Data model additions (all additive)

`document_shares`: `v, kind, permission, oneTime, maxDownloads, downloadCount, passwordHash, passwordFailures, lockedUntil, ipAllow,
domainAllow, deviceBinding, boundDeviceId, notifyOnAccess, watermark, label, note, managerEmails, lastAccessAt`.
New: `file_share_access_events` (TTL 400 d), `drm_sessions` (TTL on `expiresAt`), `share_email_codes` (TTL on `expiresAt`).

## Status

Server side verified by tests against the real database (`test/sharing-policy.test.mjs`, `sharing-shares.test.mjs`,
`sharing-routes.test.mjs`). Share manager UI, the recipient viewer page, file requests and file locks: see the implementation ledger.
