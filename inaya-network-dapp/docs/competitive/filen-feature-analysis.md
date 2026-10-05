# Filen-inspired capabilities: where Inaya stands

Scope: the Filen-inspired parts of the Competitive Expansion SOW (end-to-end encrypted collaboration around files). This analysis is based on the SOW's own description of those capabilities and on Inaya's implementation ledger (`docs/competitive-expansion-implementation-ledger.json`). **Vendor features were not independently re-verified for this document**, and statuses below are Inaya's, using the SOW's status words. Do not read a row as a claim about the other vendor.

## Principle the SOW borrows

Content a person marks private is encrypted on their device, and the server stores ciphertext only. Inaya already did this for workspace documents; the expansion extended it to chat, notes, share links and file requests, and was explicit where the model has to differ.

## Capability comparison

| Capability | Inaya implementation | Status | Honest difference |
|---|---|---|---|
| End-to-end encrypted chat (1:1, group, organization) | MLS (RFC 9420) through `ts-mls`; server is delivery and authentication service; device enrollment, KeyPackages, epoch change on membership change, removed members cannot read | 1:1 and key management VERIFIED; group and organization IMPLEMENTED_NOT_LIVE | MLS library is **not formally audited**. History is not backfilled to new members or devices. Mobile and desktop chat surfaces are not built (CHAT-021/022). Push is NOT_CONFIGURED (no push credentials) |
| Contacts | requests, accept/deny, block, presence privacy, organization search | IMPLEMENTED_NOT_LIVE | cross-organization contacts are opt-in only |
| Secure notes | client-side encrypted text, rich text, Markdown, checklist, code; history; tags; sharing with conflict handling | VERIFIED | the note passphrase cannot be recovered by Inaya |
| Share links with passwords and expiry | password, expiry, one-time, download limits, network and domain limits, delegated managers, access log | SHARE-001 VERIFIED, the rest IMPLEMENTED_NOT_LIVE | links to client-side encrypted files keep the key in the URL fragment; server-managed objects are different (see below) |
| Upload links (file requests) | end-to-end: uploads sealed to a request key generated in the requester's browser | VERIFIED | the server cannot scan the content; the page says so |
| File locks | lease, renewal, force release, stale cleanup | VERIFIED | enforcement across S3/Azure and DirectSync is PARTIAL |
| Encrypted storage via S3-compatible tools | server-managed envelope encryption, optional customer-managed keys | existing + KEY-001 PARTIAL | **server-side**: S3 clients send plaintext over TLS, so the platform (or the customer's key service) holds the data key. This is a different trust model from client-side encryption and is labelled that way |
| Desktop sync | DirectSync, Drive (existing) | existing | new desktop surfaces for chat, notes, locks and endpoint backup status are not built (DESKTOP-001) |
| Mobile apps | existing mobile app | existing | contacts, notes, shares, upload requests and offline cache screens are not built (MOBILE-001) |
| Endpoint backup | profiles, health, integrity verification, ransomware-safe restore | PARTIAL | the desktop client does not yet use the profile and health endpoints |
| Search over encrypted content | local, in the person's browser, over what that browser has decrypted | tier A is reported LOCAL; not wired into the command palette | the server never indexes encrypted content |

## What the expansion deliberately does not claim

* That every Inaya feature is zero-knowledge. Workspace documents, chat, notes and file requests are. Server-managed storage and server-side features (scanning, preview of unprotected files, DLP on content) are not, and say so.
* Perfect forward secrecy or post-compromise security beyond what MLS provides, and no claim about the audit status of the MLS library.
* That a screen-capture or a photograph can be prevented: the secure viewer describes its guarantee honestly (see `drm-viewer-security.md`).

## Open work from this comparison

CHAT-021 and CHAT-022 (mobile and desktop chat), CHAT-023 (push credentials), MOBILE-001, DESKTOP-001, wiring tier-A local search into the palette, and external review of the MLS integration.
