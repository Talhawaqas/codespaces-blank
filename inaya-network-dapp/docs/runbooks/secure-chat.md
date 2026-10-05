# Runbook: Secure Chat

Audience: operators and support. Design: `docs/architecture/e2ee-chat-key-management.md`. Threat model: `docs/security/e2ee-chat-threat-model.md`.

## What it is, in one paragraph

End-to-end encrypted chat inside the Business Workspace (menu: Collaboration, Secure Chat). Messages are encrypted on the person's
device with MLS (RFC 9420) before they are sent. The Inaya server orders and stores ciphertext and knows who is in a conversation,
when messages are sent and how big they are. It cannot read a message, a conversation title, an attachment name or an attachment.
Status: **beta**, behind `FEATURE_SECURE_CHAT`.

## Turning it on and off

| Level | How | Effect |
|---|---|---|
| One organization | The org owner/admin opts in (`setOrgFeature`, or a platform admin sets `features.FEATURE_SECURE_CHAT=true` on the org) | Chat appears for that organization only |
| Everyone | Environment variable `FEATURE_SECURE_CHAT=1` on the deployment | On for every organization |
| Kill switch | `FEATURE_SECURE_CHAT=off` | Off for everyone at once, beats every other setting. Routes answer 404. Stored data is untouched |

Per-organization policy (owner/admin, `PATCH /api/orgs/chat/settings`): `allowExternal` (people outside the organization, default
off), `allowEditing` and `allowDeleting` (default on).

## What users will notice (set expectations)

* **A browser or app is one device.** Keys and the decrypted cache live only on that device. A second device (phone) sees only
  messages sent after it joined. There is no history sync between devices in this version.
* **People who join a conversation later cannot read earlier messages.** This is a property of the protocol, not a bug.
* **Clearing browser site data deletes the device's keys.** The person must sign in again; the old device shows as inactive in
  the device list and should be revoked. Their old messages cannot be recovered on the new device.
* **A person can only be added once they have opened Secure Chat once** (so they have a device with keys). Until then the
  conversation shows "Waiting for … to open Secure Chat".
* Notifications say "New secure message" and never include text or names.

## Common situations

| Symptom | Likely cause | Action |
|---|---|---|
| "Secure Chat is not enabled" | Flag off for the org | Enable per organization (above) |
| "This browser cannot run Secure Chat" | No WebCrypto Ed25519/X25519 (very old browser) | Update the browser or use the desktop app |
| "storage is busy in another tab" | Another tab holds the browser's database during an upgrade | Close other Inaya tabs, reload |
| "Waiting for X to open Secure Chat" | X has no device yet | Ask X to open Secure Chat once |
| Message says "A member or device is being removed" (409 `RECONCILE_REQUIRED`) | A removal is pending; sends wait until a member's device applies it | Normal and automatic; the sender's app applies it and retries. If it persists, open the conversation on a device that is online |
| 409 `STALE_EPOCH` | Two devices changed the group at once | Automatic retry; if repeated, reload |
| Lost phone | Device still has keys | Revoke the device (see `device-revocation.md`) |

## What to check when something looks wrong

1. `chat_security_events` (per organization, metadata only, 90-day TTL): `KEYPACKAGE_IDENTITY_MISMATCH`, `COMMIT_ILLEGAL_ADD`,
   `COMMIT_ILLEGAL_REMOVE`, `COMMIT_WRONG_GROUP`, `MESSAGE_WRONG_GROUP`, `DEVICE_REVOKED`, `PARTICIPANT_REMOVED`. A single event is
   usually a client bug; a burst from one user is worth a look.
2. `org_activity` (recordType `CHAT_*`) and the audit chain carry conversation creation, participant changes, epoch changes,
   device enrollment/revocation and attachment uploads. They contain ids and counts, never content.
3. Device list: `GET /api/orgs/chat/devices?all=1` (owner/admin).

## What operators can and cannot do

* Can: enable/disable the feature, set org chat policy, revoke any device, see metadata and security events, delete a
  conversation for everyone (owner of that conversation or org admin of an org conversation) which erases stored ciphertext.
* **Cannot: read messages, titles or attachments.** There is no recovery key and no admin decryption. Do not promise otherwise.
* Cannot recover a user's history after they lose all their devices.

## Data retention

* Messages: kept until deleted by the sender (within 7 days), the conversation owner, or conversation deletion.
* Presence and typing: expire by TTL (90 s / 6 s). Notification delivery rows: 14 days. Security events: 90 days.
* Revoked devices: KeyPackages and pending Welcomes are deleted at once; the device row stays for audit.

## Deployment notes

* No WebSocket is required. The client long-polls `/sync` (held up to 25 s) and can use `/stream` (server-sent events). Both work on
  a serverless platform; set the function duration to at least 30 s for those two routes (`maxDuration` is already 30).
* Attachments are uploaded in 1.5 MiB encrypted parts (the platform's per-request limit stays untouched). Maximum 25 MB.
* Mobile push is **not configured** (needs Expo/FCM/APNs credentials). In-app notifications work.
