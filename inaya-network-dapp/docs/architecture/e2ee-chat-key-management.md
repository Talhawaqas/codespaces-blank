# ADR: End-to-end encrypted chat — key management and group protocol

Status: accepted 2026-10-04 (owner decision: real MLS, "Option B"). Scope: Inaya Secure Chat (SOW workstream A).
Companion: `docs/security/e2ee-chat-threat-model.md`.

## 1. Decision

Inaya Secure Chat uses **Messaging Layer Security, RFC 9420**, through the open-source `ts-mls` library (pinned to 1.6.4, MIT,
pure TypeScript, one runtime dependency `@hpke/core`). We do **not** design our own ratchet or group protocol (SOW §0.13, §33.1).

* Cipher suite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (id 1). Chosen because it needs no extra dependency and runs on
  Web Crypto (browsers, Node 20+, Tauri webviews). React Native, which has no `crypto.subtle`, uses the library's `nobleCryptoProvider`.
* The Inaya server is the MLS **Delivery Service** (stores and orders opaque protocol messages) and the **Authentication Service**
  (binds an MLS credential to an authenticated Inaya identity). It never holds any MLS secret.
* Existing Inaya crypto (AES-GCM vault encryption, X25519/XChaCha sharing envelopes) is **not** changed and is not used for chat.

Alternatives rejected: (a) a v1 "epoch key wrapped to each device" scheme built from our own X25519/XChaCha envelope — simpler but
no forward secrecy or post-compromise security inside an epoch, and the SOW forbids representing it as equivalent to a ratcheting
protocol; (b) Signal protocol libraries — pairwise only, group fan-out and membership semantics would be ours to invent.

### Honest status of the library

`ts-mls` states that it **has not undergone a formal security audit**. We mitigate by pinning the exact version, exercising the
security properties we rely on in our own tests (removed member cannot read later messages, tampered ciphertext rejected, wrong
epoch rejected, replay rejected, new member cannot read earlier messages), and documenting this as an unresolved risk in the final
verification report. Chat is therefore labelled **beta** in the product until an independent review exists.

## 2. Identities and devices

* One **device** = one MLS client = one leaf in each group it belongs to. A person with a phone and a laptop has two devices.
* Credential: MLS `basic` credential whose identity bytes are UTF-8 `inaya:v1:<orgId>:<email lowercase>:<deviceId>`.
* Enrollment (`POST /api/orgs/chat/devices`): the device generates its own Ed25519 signature key pair and its first KeyPackages
  **on the device**. The server stores the device's public signature key, the SHA-256 fingerprint of it, and the owner. The server
  verifies, by decoding each uploaded KeyPackage, that (1) the credential identity equals the authenticated caller's
  `orgId/email/deviceId`, (2) the leaf signature key equals the enrolled key, (3) the KeyPackage signature is valid and the
  lifetime is sane. A KeyPackage failing any check is rejected.
* Revocation (`POST .../devices/:id/revoke`): server stops serving the device's KeyPackages and Welcomes, rejects its API calls,
  and marks it for removal. Any group member's client sees the pending removal on its next sync and issues a Remove commit, which
  moves the group to a new epoch the revoked device cannot decrypt.
* Private keys (signature key, HPKE init/encryption keys, group state) are generated and kept **only on the device**:
  * web: Web Crypto `AES-GCM` wrapping key created with `extractable:false` and stored in IndexedDB; the MLS state blob is
    encrypted with it before it is written. Plaintext state never touches `localStorage`.
  * mobile: `expo-secure-store` for the wrapping key, biometric/PIN gate before use; encrypted blob in the app sandbox.
    Never AsyncStorage.
  * desktop: the OS credential store already used for the passkey, same wrapping-key pattern.
* Single-use KeyPackages: each device publishes a batch; the server hands out one per claim atomically
  (`findOneAndDelete`-style consume). A flagged `lastResort` package is served only when no single-use package remains.

## 3. Groups, epochs and who may change them

Every conversation (1:1 included) is one MLS group. `groupId` = random 16 bytes chosen by the creator, equal to the
server-side `conversationId`. The server keeps `epoch` (the current MLS epoch) and a monotonically increasing `seq` for the event
log of each conversation.

* **Commits are sent as MLS public messages** (`wireAsPublicMessage: true`), because the proposals inside (Add/Remove) are
  membership facts the server must know anyway. This lets the server **decode every commit and check it** instead of trusting
  claims in request metadata. Application messages remain `PrivateMessage` (encrypted) — the server cannot read them.
* **Ordering**: a commit is accepted only if `baseEpoch == conversation.epoch`; the epoch is advanced with a single atomic
  conditional update, so two simultaneous commits cannot both win (the loser is told to sync and retry).
* **Server authorization of commits** (all enforced server side, before the commit is stored or any Welcome delivered):

  | Proposal in the commit | Allowed when |
  |---|---|
  | Add device D | D belongs to a *current participant* of the conversation (new device of a member, or a participant being added in this same request by an owner/admin) and D is not revoked |
  | Remove device D | D is revoked, **or** D's owner has left/was removed from the participant list, **or** D is the committer's own device |
  | no Add/Remove (empty "update path" commit) | committer is a current participant; used for key rotation |

  Participant adds/removes (`participants` routes) are authorized separately: group conversations — owner/admin of the
  conversation; 1:1 — nobody (fixed at two); organization conversations — managed by org owner/admin.
* **Client-side authorization too**: each client passes an `IncomingMessageCallback` that rejects a commit unless it only adds
  or removes devices whose credential identity matches the policy above (a malicious server cannot slip an extra device into a
  group without the other members' clients refusing the commit). Credential validation (`AuthenticationService`) checks the
  identity format and that the signature key matches the device directory fingerprint the client has pinned.
* **Removal semantics**: after a Remove commit the removed leaf has no path to the new epoch secrets. A removed member keeps
  anything they already decrypted (unavoidable) and cannot read anything sent from the new epoch onward.
* **Joining semantics**: a Welcome gives a new device the group's current epoch only. MLS has no access to earlier epochs, so a
  new participant **cannot read history**. There is no "backfill" option in v1; it would require re-encrypting history to the new
  member and is recorded as FUTURE.
* **Multi-device**: a new device of an existing member is added by another device of that member (or any member's client) that
  observes `devicesMissing` in the sync response. A user with only one device who enrols a second one sees only new messages.

## 4. What the server stores for each message

`chat_messages` rows hold: `conversationId`, `seq`, `epoch`, `senderEmail`, `senderDeviceId`, `kind` (`app`, `commit`),
`clientMsgId` (idempotency), `ciphertext` (the encoded MLS PrivateMessage), `size`, `createdAt`, and for edit/delete the
`targetMessageId`. **No plaintext, no keys.** Titles, message text, attachment names, file keys and edit contents are all inside
the encrypted payload. The server can see who talked to whom and when and how big a message was (metadata) — see the threat model.

Application payload (inside MLS ciphertext, versioned JSON): `{v:1, t:"msg"|"edit"|"del"|"rename"|"meta"|"ack", ...}`.
`msg` carries text and an `attachments[]` array. `rename` and `meta` carry the encrypted title. An adder sends a `meta` message
after every Add so a new member learns the title.

Edit/delete authorization: the server checks the event's `targetMessageId` belongs to the caller within the same conversation
(and the policy window), and every receiving client checks that the edit/delete came from the original sender's credential
before applying it.

## 5. Attachments

* Existing Inaya file: the payload carries `{kind:"inaya-doc", documentId, name, size}`. The bytes are not copied and no key is
  placed in the chat; the recipient must independently pass the normal document permission checks (and, for zero-knowledge
  vault files, holds the file's own passkey out of band). The conversation grants nothing by itself.
* Local file: encrypted on the device with a random 256-bit key (AES-256-GCM, random 96-bit nonce per file; 4 MiB chunks for large
  files) before upload. The ciphertext is stored as an opaque blob tied to `(orgId, conversationId, uploaderEmail)`; only
  participants can fetch it; the key, nonce, SHA-256 of the ciphertext, name and type travel only inside the MLS message.
* Image previews are produced client-side after decrypt; no thumbnail is stored server side.

## 6. Notifications, presence, typing, read state

Metadata only. Push/notification payloads carry no message text (default string "New secure message"); a per-user opt-in
"show sender name" mode exists, never message text. Presence and typing are short-TTL rows. "Appear offline" suppresses the
caller's presence for everyone. Read state stores only the last seq read per user per conversation.

## 7. Search

Server-side search over message text is impossible by construction. Clients keep an encrypted local index of decrypted messages
and search it locally (conversation list search uses locally cached titles).

## 8. Properties claimed (and not claimed)

Claimed, because MLS provides them and our tests exercise them: message confidentiality and integrity; sender authentication
inside the group; forward secrecy (message keys are deleted after use) and post-compromise security (after a commit by an
uncompromised member); post-removal secrecy; no history for new members.

**Not** claimed: metadata privacy from the server; protection if a device is compromised while unlocked; protection against a
malicious server that substitutes a device's KeyPackage *unless* users compare device fingerprints (shown in the UI as a
"safety number" per participant); deniability; an independent audit of the library; post-quantum security (the PQ cipher suites
exist in the library but are not enabled).
