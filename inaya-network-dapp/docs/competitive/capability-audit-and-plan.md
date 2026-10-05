# Competitive Expansion SOW — Capability Audit and Implementation Plan

Source: `INAYA_Filen_FileCloud_ClaudeCode_SOW.md` (66 sections, 2026-10-04).
Audit date: 2026-10-04. Method: read the code, routes, collections and tests listed below. Nothing here is assumed;
each "EXISTS" line names the file that proves it. Status words follow SOW §0.16.

Repos in scope: `inaya-network-dapp` (web + API), `custody-sdk`, `inaya-desktop` (Tauri), `inaya-drive-core` / `inaya-drive-helper`
(Rust), `inaya-mobile` (separate repo), `ad-sync-agent`, `inaya-migration-agent`.

---

## 1. Capability matrix (what already exists, what is partial, what is missing)

### Already deployed — overlaps with the SOW (decision needed: skip, extend or rebuild)

| SOW item | Evidence it exists | What the SOW still adds on top |
|---|---|---|
| Link sharing: expiry, max uses, revoke, atomic one-use consume (B1) | `src/lib/document-permissions.js` `createDocumentShare / consumeDocumentShare / revokeDocumentShare`, route `api/orgs/documents/[id]/shares`, `api/orgs/share/[token]`. Token is 256-bit, only its SHA-256 is stored | Password, view-only/upload-only, IP/domain restriction, access notification, group share, share manager screen |
| Data Rooms with NDA gate, templates, sections, invites, revoke, access log, evidence export (K) | `src/lib/external-data-room.js`, `dataRoomTemplates.js`, `dataroom.js`, `dataRoomEvidence.js`, routes `api/orgs/data-rooms/**`, `api/data-room-access/**` | Watermark, view-only/no-download, per-section permissions, final-version pin, visitor expiry controls, bulk management |
| Legal hold + retention (D4) | `src/lib/retention.js` (`isUnderLegalHold`), `legal-hold-workflow.js`, S3 Object Lock / legal hold in `s3-compat/store.js`, `walletStore.js` | One governance policy model with versioning that covers all file paths |
| Data classification levels (D2) | `src/lib/classification.js`: 10 levels, narrowing-only on top of `resolveLevel()`, per-org config | Rule engine, confidence, history, pattern/PII detection, metadata sets |
| Policy gate "may this action happen" (D3 DLP core) | `src/lib/policy-engine.js`: pure evaluator, `allow / warn / require_approval / block`, high-risk actions default to `require_approval`; used by `export-center.js` | Not wired to shares, downloads, uploads or S3; no IP/device/path fields; no events collection |
| Malware screening (Y) | `src/lib/support/scanner.js`: static inspection + optional ClamAV/Cloudmersive, fail-closed mode | Only used for support attachments, not for general uploads/S3 |
| Ransomware detection (F) | `src/lib/nas/ransomware.js`: entropy, extension, ransom-note, snapshot lockdown with human approval | NAS only; no equivalent for cloud documents / S3 |
| Signed webhooks with retry, backoff, DLQ, redelivery (X) | `src/lib/s3-compat/notifications.js` (S3 events), `src/lib/support/webhooks.js` (support events), SSRF-safe | No general org webhook registry for share/DLP/chat-metadata/identity events; no secret rotation or endpoint pause |
| Audit chain + Evidence Graph + evidence export (all) | `auditChain.js`, `org-activity-log.js`, `evidence.js`, `evidenceExporter.js`, `businessEvents.js`, public `api/public/v1/audit/verify` | Reuse as is |
| Compliance frameworks, controls, evidence, exceptions (P) | `compliance-frameworks.js` (NIST CSF 2.0, ISO 27001, SOC 2, DORA, GDPR, GLBA, SEC IA), `compliance-controls.js`, `compliance-evidence.js`, `compliance-exceptions.js` | NIST SP 800-53 catalog, OSCAL export, government profile, FIPS-ready crypto abstraction |
| Data residency policy (D1/P) | `src/lib/data-residency.js` | Region class on files; enforcement on all write paths |
| Identity: AD sync agent, SCIM, OIDC SSO, Entra (N, J) | `ad-sync-agent/`, `api/scim/v2`, `integrations/sso.js`, `integrationProviders/genericOidc.js`, `src/lib/identity/**` | NTFS ACL reading, SMB connector (Gateway) |
| Notifications framework (V, A6) | `src/lib/notifications.js` (in-app, per org/wallet, dedupe) | Email/push/desktop/webhook channels per event; chat events |
| Unified search, org scope (H) | `src/lib/orgSearch.js` (uses `getAccessibleScope()` only), RAG under `src/lib/rag/**` | Files, notes, chat metadata, classification state; local E2EE tiers |
| File versions (B4/I) | `api/orgs/documents/[id]/versions` | Version pinning in viewer; restore UX |
| S3 / Azure / GCS compatibility, DirectSync, Drive, resumable multipart, presigned links (§3, §40) | `src/lib/s3-compat/**`, `inaya-drive-core` (single S3 signer), `inaya-desktop/src-tauri/src/directsync.rs` | Reuse; must honour new lock/DLP/legal-hold checks |
| Workflow engine with event/evidence/data-change triggers (32) | `src/lib/workflows/nodes.js` (`trigger.event`, `trigger.evidence_event`, `trigger.data_change`), guarded execution | File triggers and file actions |
| Customer Portal + support uploads with scanning (L) | `src/lib/support/portalApi.js`, `uploads.js`, `scanner.js` | Standalone file-request links |
| Role gates (T) | `src/lib/orgGates.js` (canManage*/canAccess* per domain) | A few additive gates only where a real scope split exists |
| Rate limiting | `src/lib/rateLimit.js` (`checkRateLimit`, `slidingWindowCheck`, `getClientIp`) | Reuse for chat, contacts, file requests |
| Crypto primitives for E2EE (§3.1) | `custody-sdk/src/crypto.js`: AES-GCM-256, PBKDF2, `@noble` X25519 + HKDF + XChaCha20-Poly1305 (`encryptForPublicKey`, `deriveEncryptionKeypairFromSignature`) | Reuse for chat v1 envelopes (see ADR plan) |

### Genuinely absent (verified by search: no collection, no module, no route)

- Secure Chat, secure Contacts, presence, typing (note: `crm_contacts` is a CRM record, unrelated).
- Secure Notes and note history/tags/participants.
- Password-protected links, view-only/upload-only shares, share manager UI, file requests / upload links, file comments.
- Generic file locks (only workflow-level locks exist).
- Metadata sets, classification rules/history, pattern/PII search for files.
- DRM / secure viewer (no watermarking anywhere in Data Room code).
- Device inventory, device policies, remote session/device block, app-data wipe. (Sessions exist: `orgs.js` `createSession/getSession`; no per-device records.)
- Real mobile push: `expo-notifications` is installed but `NotificationsScreen.js` states it is deliberately not tray push; there is no push-token registration and no push sender.
- Sovereign Gateway (the NAS agent drives a local WSL appliance; `ad-sync-agent` / `inaya-migration-agent` are the nearest outbound-agent patterns).
- NIST 800-53 catalog, OSCAL export, government profile, crypto-provider registry (FIPS-ready), customer-managed key providers (S3 compat has a server-held wrapped key only: `s3-compat/crypto.js`).
- Tenant branding beyond an empty `profile.branding` object; Office/Outlook integration; org-level admin dashboard for these features; file favorites/pin/tags.

### Constraints that shape the design

1. **Vercel serverless**: no persistent WebSocket. Chat transport = HTTPS + SSE/long-poll with sequence-numbered replay, polling fallback (SOW A7 anticipates this).
2. **Zero-knowledge**: chat, notes and any "private" classification run client-side. Server stores ciphertext only.
3. **Mobile push** needs APNs/FCM (via Expo push service) credentials the project does not have. Built behind an adapter; status `NOT_CONFIGURED` until credentials exist. Payloads are generic text only.
4. **Real MongoDB** (`inaya_network_corporate`) is what tests run against; fixtures must be disposable and deleted by exact id.
5. This repo's Next.js is non-standard (`AGENTS.md`): read `node_modules/next/dist/docs/` before writing any new route/page code.

---

## 2. Architecture decisions I am proposing (need your answer on #1)

1. **Chat crypto v1.** No custom ratchet. Per-conversation symmetric key (XChaCha20-Poly1305) with an **epoch**; each epoch's key is wrapped to every member **device** public key using the existing X25519 + HKDF + XChaCha20-Poly1305 envelope. Add/remove member or revoke device = new epoch; removed members never receive later epoch keys; new members get no old epochs (backfill off by default). Messages are signed with the sender device key (Ed25519, `@noble/curves`) and bound to `(conversationId, epoch, seq)` to stop substitution and replay. The ADR states plainly: **no forward secrecy / post-compromise security within an epoch, unlike Signal/MLS**. MLS is the documented upgrade path (SOW §54.1). Alternative: adopt an MLS library now (more complete security, much more work, React Native compatibility risk).
2. **Where private keys live**: web = WebCrypto non-extractable where possible, otherwise passkey-derived (existing `deriveEncryptionKeypairFromSignature`); mobile = `expo-secure-store` + biometric gate; desktop = OS credential store (already used for the passkey). Never AsyncStorage/localStorage for plaintext.
3. **DLP = extend `policy-engine.js`** (new fields: IP/CIDR, device, path prefix, file type, share type, download count, destination domain; new results `require_stronger_auth`, `log_only`, `quarantine`), add `dlp_events`. One evaluator, wired into share creation, link redemption, download, upload, S3/Azure routes. No second policy engine (SOW §53).
4. **Governance policies** become a versioned, immutable-after-publish collection that feeds that same evaluator.
5. **File locks** = one `file_locks` collection with lease/expiry; checked by document write paths, S3 write/delete (like Object Lock/legal hold already are), and DirectSync (new HTTP status mapped by the existing `status_for_http`).
6. **Feature flags** `FEATURE_*` per SOW §55, default OFF; existing users unaffected.
7. **Ledger + final verification report** created as the SOW demands (`docs/competitive-expansion-implementation-ledger.json`, `docs/competitive-expansion-final-verification.md`).

---

## 3. Implementation plan (phases, in dependency order)

Each phase ends with: unit + real-DB tests, adversarial tests, real-browser pass for UI, ledger update. Only features verified get a status above `IMPLEMENTED_NOT_LIVE`.

| Phase | Content | SOW refs | Size |
|---|---|---|---|
| 0 | Capability audit (this file), ADR + threat model for chat, ADR for gateway, ledger skeleton, feature-flag helper, tenant-isolation scanner test harness | §0, §33, §57, S | small |
| 1 | **Secure Chat core (server + crypto + tests)**: conversations, participants, epochs, devices, key envelopes, messages, read/mute/typing/presence, SSE transport, notifications (generic payload), rate limits, audit metadata. Contacts (requests/block). Adversarial test set from §A11 | A, §46 | very large |
| 2 | Chat UI (web, Business Workspace "Collaboration" group), attachments (existing Inaya file refs + local encrypted upload), browser verification | A5, §37 | large |
| 3 | Secure Sharing 2.0: password, share kinds, IP/domain limits, access notify, share manager, file requests (upload links with scanner), file locks (+S3/DirectSync enforcement) | B | large |
| 4 | Notes (E2EE) + contacts integration + note sharing | C | medium |
| 5 | Governance: metadata sets, classification rules + history (client-side path for E2EE), DLP via `policy-engine`, governance policy versions, upload governance (MIME check, archive limits, hash lists, scanner on all uploads), file workflow triggers | D, Y, 32 | very large |
| 6 | DRM/secure viewer (watermark, view-only, short-lived sessions, honest copy) + Data Room 2.0 extras | E, K | medium |
| 7 | Device inventory/control + remote session/device block + app-data wipe request; endpoint backup v2 (DirectSync profiles, health, restore report) | G | large |
| 8 | Ransomware signals for cloud files/S3, general webhook registry (rotation, pause), org branding, admin dashboard, role gates, unified search v2, public API v1 + SDK namespaces + CLI | F, X, R, U, T, H, W | large |
| 9 | Sovereign Gateway (agent + registration + one connector + one real lab test), network folder / ACL bridge (as far as a real lab allows) | M, N | very large |
| 10 | Compliance readiness: government profile, NIST 800-53 catalog, OSCAL-shaped evidence export, crypto-provider registry, customer-managed key provider interface | P, Q | large |
| 11 | Mobile + desktop surfaces, push adapter (`NOT_CONFIGURED` until credentials), full regression, docs, final verification report | §39, §40, §44, §58 | large |
| Later / external | Office/Outlook integration, DICOM, site replication, HA tooling, WebDAV/File Provider: adapters only where a real sandbox exists; otherwise `FUTURE`/`NOT_CONFIGURED` with the architecture recorded | J, O, I | — |

Honest sizing: this is several weeks of focused work. Phases 1–2 alone are comparable to the largest SOWs already shipped.

---

## 4. Things that will honestly end up `NOT_CONFIGURED` / `PARTIAL` unless you provide something

- Mobile push delivery (needs Expo/FCM/APNs credentials).
- Real AD/NTFS lab and Office/Outlook sandbox (needs a Windows Server/AD lab or tenant).
- Outbound email branding/custom domains per org (needs DNS + Resend domain).
- FIPS-validated crypto (cannot be claimed; only the abstraction is built).
- FedRAMP / government certification (never claimed).
