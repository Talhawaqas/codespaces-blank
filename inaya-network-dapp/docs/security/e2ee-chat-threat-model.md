# Threat model: Inaya Secure Chat (E2EE)

Companion to `docs/architecture/e2ee-chat-key-management.md`. Status: 2026-10-04, pre-implementation; updated with test
evidence in `docs/competitive-expansion-final-verification.md`.

## Assets

1. Message plaintext, attachment plaintext and file keys. 2. Device private keys and MLS group state. 3. Membership integrity
(who is in a conversation). 4. Tenant isolation (org A never sees org B's chats). 5. Availability of delivery. 6. Chat metadata.

## Actors

| Actor | Capability assumed |
|---|---|
| Honest-but-curious server operator / DB reader | Reads all stored rows and logs |
| Malicious or compromised server | Can alter, drop, reorder, replay and inject any API response or row |
| Removed member / revoked device | Valid past credentials and past group state; can still call public routes |
| Malicious member | Authenticated participant who violates client rules |
| Other tenant / outsider | Authenticated in another org, or unauthenticated |
| Network attacker | Reads/modifies traffic (TLS assumed, but replay/tamper still tested) |
| Stolen unlocked device | Local access to app state |

## Threats and mitigations

| # | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | DB leak exposes messages | Only MLS ciphertext stored; no keys server side | persisted-row scan asserts plaintext absent |
| T2 | Server reads message bodies | Server has no group secrets; `PrivateMessage` | same |
| T3 | Removed member reads new messages | Remove commit -> new epoch; server also refuses removed member's reads and sends | removed-member decrypt + route tests |
| T4 | New member reads history | MLS Welcome contains current epoch only | new-member test |
| T5 | Ciphertext substitution across conversations/epochs | MLS binds groupId and epoch into the framed content; server binds `(conversationId, seq)`; tests post a ciphertext into another conversation | substitution tests |
| T6 | Replay | Idempotency `clientMsgId` unique per conversation+sender; MLS rejects replayed generation | replay tests |
| T7 | Forged sender / participant spoofing | MLS signature by sender leaf; server derives sender from session, never from body | spoof tests |
| T8 | Stale-epoch commit / race | atomic `baseEpoch == epoch` compare-and-set | concurrent commit test |
| T9 | Malicious member adds a rogue device | Server decodes public commit and checks each Add against participant devices; clients reject non-conforming commits | rogue-add tests |
| T10 | Revoked device keeps working | Server rejects it everywhere; Remove commit rotates epoch | revocation tests |
| T11 | Cross-tenant access | Every query scoped by authenticated org / participant; fail closed | isolation scanner + tests |
| T12 | Malicious server swaps a KeyPackage for its own | Server-side checks bind credential to authenticated user; **residual**: clients that do not compare fingerprints cannot detect a fully malicious server. UI shows per-participant safety numbers. | fingerprint display test |
| T13 | Push notification leaks content | Generic payload, enforced in the single notification builder | notification test |
| T14 | Attachment access by non-participant | Blob routes check participant status per request; keys only inside MLS | attachment tests |
| T15 | Oversized/malformed payloads, abuse | Size caps, strict decoding, per-user rate limits, per-conversation quotas | limits tests |
| T16 | Logs leak secrets | No request/response bodies of chat routes logged; error messages generic; audit entries carry ids and counts only | log-leak test (captures console during a run) |
| T17 | Stolen device | OS-bound wrapping key, biometric/PIN gate, remote device revoke, cache wipe request | device tests; mobile manual |
| T18 | Library defect | Pinned version; our tests; documented as unaudited; beta label | final report |

## Residual risks (stated, not hidden)

* Metadata (participants, timing, sizes, device list) is visible to the server.
* A fully malicious server can attempt AS-level impersonation until users verify safety numbers.
* The MLS library has not been independently audited.
* A removed member retains what they already saw.
* Compromise of an unlocked endpoint exposes that device's decrypted history.
