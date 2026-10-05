# Runbook: Revoking a chat device

Use when a phone or laptop is lost, stolen, sold, or no longer trusted, or when a person leaves.

## Who can do it

The device's owner (from their own device list) or an organization owner/admin (`POST /api/orgs/chat/devices/{deviceId}/revoke`).
Anyone else gets 403.

## What happens, in order

1. **Immediately, server side:** the device is marked revoked; every chat call made with it is refused (403 `DEVICE_REVOKED`);
   its stored KeyPackages are deleted (nobody can add it to a new conversation); its undelivered Welcomes are deleted.
2. **At the next sync of any other member:** each conversation the device was part of reports the device in its removal plan. The
   member's app issues an MLS Remove commit, which moves the conversation to a new epoch that the revoked device has no keys for.
3. **Until that happens,** sends in the affected conversations are refused with `RECONCILE_REQUIRED`, so no message is ever
   encrypted to a group that still contains the revoked device. The sender's app applies the removal first and then sends.
4. The revoked device, if it comes online, is told it is revoked and wipes its local keys and cache.

## What revocation does NOT do

* It cannot erase what the device already decrypted and stored locally; it only stops future messages. If the device is
  physically lost, local data is protected by the operating system's lock and, on the web, a non-extractable key; treat it as
  possibly exposed up to the revocation moment.
* It does not sign the person out of the Business Workspace. Use the ordinary session/MFA controls for that.

## Checklist for a lost device

1. Revoke the device (owner or admin).
2. Check `chat_security_events` for `DEVICE_REVOKED` and any unusual `COMMIT_*` events before the revocation.
3. If the person had only that one device, they re-open Secure Chat on a new device; they will see new messages only.
4. If sensitive conversations were open on the device, consider whether the information in them needs rotating (passwords, etc.).

## Verification (what the tests prove)

`test/chat-protocol.test.mjs` ("device revocation") and `test/chat-routes.test.mjs` ("device handling over HTTP") show: the revoked
device is refused on every route, is removed from the group, cannot decrypt the next message, and has no KeyPackages left.
