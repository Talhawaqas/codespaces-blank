# Competitive Expansion: final verification report

Scope: the "Filen / FileCloud competitive expansion" statement of work (SOW), implemented in the Inaya web application, the public API, the SDK/CLI, the sovereign gateway agent and the documentation set. Written 2026-10-05 against the repository state at the commit that contains this file.

**How to read this.** `docs/competitive-expansion-implementation-ledger.json` is the source of truth for status; section 21 below is generated from it (`node scripts/competitive-ledger.mjs report`). Status words are used strictly:

| Status | Meaning here |
|---|---|
| VERIFIED | Built, covered by automated tests that ran green against the real database, and (where it has a screen) exercised in a real browser on a production build |
| IMPLEMENTED_NOT_LIVE | Built and tested at the server/library level; not fully exercised through a real browser or a real external system |
| PARTIAL | Part of the item is built; the note says exactly what is missing |
| NOT_CONFIGURED | Needs a credential or external system only the owner can provide |
| PLANNED | Not built |

"Deployed" in this report means: committed and pushed to the web repository, whose pushes deploy the site. Every new capability sits behind a `FEATURE_*` flag that is **off by default**, so nothing changes for an organization until it opts in (`docs/runbooks/competitive-rollback.md`).

## 1. Summary

| Status | Items |
|---|---|
| VERIFIED | 45 |
| IMPLEMENTED_NOT_LIVE | 38 |
| PARTIAL | 28 |
| PLANNED | 3 |
| **Total** | **114** |

The SOW is **not complete**: the mobile surfaces (CHAT-021, CHAT-023, MOBILE-001) are not built (deferred by the owner for now), and several items are PARTIAL or IMPLEMENTED_NOT_LIVE for the reasons in section 21.

## 2. What is implemented

By area (details and honest limits per item are in section 21):

- **Secure Chat**: real MLS (RFC 9420) group messaging through the `ts-mls` library, the server acting only as delivery and authentication service and storing ciphertext; device enrollment and revocation enforced server side; groups, organization conversations, mute/archive/unread, encrypted attachments, typing/presence, local encrypted search, long-poll and SSE transport; contacts with request/accept/block; 29 routes under `/api/orgs/chat`.
- **Secure notes**: end-to-end encrypted notes, revisions, sharing inside the organization, note references in chat.
- **Sharing 2.0, file requests, locks**: link and member shares with expiry, openings, downloads, password, IP/domain restrictions, watermark and notify options, share manager and access events; inbound encrypted file requests; file locks enforced in the new-version route and the S3/Azure store.
- **Governance**: metadata sets, versioned policies with approval, classification with history and manual override, DLP decisions (allow, deny, require approval, log-only, quarantine), upload governance (extensions, MIME sniffing, archives, bombs, hash lists), secure document viewer with an honest guarantee text, data room v2.
- **Devices, ransomware signals, endpoint backup**: device inventory and control, cloud-file ransomware signals with containment, endpoint backup profiles, health, restore plans.
- **Platform**: webhook registry with signed, replay-protected deliveries, delegated admin roles, admin dashboard, branding, notification router, unified search, public API v1 additions (shares, requests, governance, classification, devices, backup, compliance), SDK namespaces and CLI command groups.
- **Sovereign gateway**: Ed25519-signed agent protocol, one-time enrollment, resumable end-to-end-encrypted transfer, NTFS ACL evaluation, gateway audit anchored in the organization's audit chain, health, deployment modes; the zero-dependency agent in `inaya-gateway-agent/`.
- **Resilience and integrations**: active-passive site replication measured from real replica records; Office edit sessions (sovereign: no plaintext to Microsoft) and an Outlook add-in; customer portal requests.
- **Compliance and keys**: NIST SP 800-53 Rev. 5 internal control catalog (251 controls) on the existing framework engine, control status/owners/evidence/exceptions, live collectors, government-profile readiness checks, OSCAL-shaped evidence package, FIPS-ready crypto policy with known-answer self-tests, customer-managed keys (platform / local / AWS KMS) with envelope re-wrap, rotation and disable switch.
- **Operations**: job reliability wrapper (`src/lib/jobs/run.js`), privacy-safe metrics (`docs/architecture/observability-and-performance.md`), additive migration check and rollback runbook.

## 3. Deferred features (SOW section 54, deferred on purpose)

Cross-organization encrypted Digital Twin computation; universal OS-level screenshot prevention; a fully air-gapped cloud service; a physical NFS server inside the control plane; compute/hypervisor orchestration; mainnet deployment; government certification or an ATO; publishing a Terraform provider; an unrestricted public chat API. None of these is claimed. Mode 4 of the gateway deployment modes (air-gapped) is recorded as a setting only.

## 4. Partial features

See the PARTIAL rows in section 21; each says what is missing. The ones a reader is most likely to ask about: REQ-002 (no antivirus or classification on end-to-end-encrypted uploads, because the server cannot read them), DLP-002 (`REQUIRE_STRONGER_AUTH` is enforced as a refusal because the platform has no step-up mechanism), GOV-003/004 (retention and legal-hold are enforced at the S3/Azure chokepoint; the Business Workspace delete route was not re-verified), CLASS-003 (no scanner UI for the client-side verdict API), WORKFLOW-001/002 (only some triggers and actions), OBS-001 (no dashboard panel), PERF-001 (no production-scale load test), DOC-001 (docs site pages not extended).

## 5. Not-configured integrations

A live Active Directory lab for the NTFS bridge (exercised only through `icacls` on a Windows machine and unit tests); a Microsoft 365 tenant for the Office add-in (control plane tested, the add-in itself not loaded into Outlook); live AWS KMS (tested against a local AWS-protocol stub with the real SDK); custom-domain routing for branding; Resend inbound e-mail for customer-portal replies.

## 6. Files, routes, collections

Per-item file, route and collection lists are in `docs/competitive-expansion-implementation-ledger.json` (about 160 files, 47 routes listed in it; later phases add routes under `/api/orgs/{gateway,replication,office,compliance,metrics,...}` and `/api/gateway/v1`, `/api/public/v1`, `/api/metrics`). `node --env-file=.env.local --import ./test/_next-loader.mjs scripts/competitive-migrate.mjs` lists the **82 collections** the new modules reference, with document and index counts (79 existed at the time of writing; the rest are created on first write).

## 7. SDK and CLI

`custody-sdk` (separate repository, nested in this one): `Shares`, `FileRequests`, `Governance`, `Devices`, `Compliance` (`summary`, `controls`), and `Webhooks.verify`. CLI command groups for shares, file requests, devices, governance and backup, using an API key only. **There is no Chat, Contacts or Notes client and no chat CLI command, deliberately**: those are end-to-end encrypted and a key-less SDK cannot read them; a server-side chat wrapper would have to hold keys.

## 8. Desktop

Built in `inaya-desktop` (the Business Workspace app; the wallet dApp wrapper is not a chat surface) and the web code it hosts: a standalone chat window, a one-owner-window guard with handoff, native chat alerts and a tray unread tooltip that carry a number only, a "Desktop app" device identity, erase-history and remove-device controls, an organization sign-out policy (keep, clear, revoke) applied at sign-out, and offline indicators. DirectSync, Drive, secure links and the tray already existed. Details and limits: `docs/architecture/desktop-secure-chat.md`.

Verified: server tests (`test/desktop-chat.test.mjs`, 4/4), `cargo test chat_alert_tests` (2/2), `cargo check`, and a real-browser pass with a stand-in native bridge (handoff between two tabs, pop-out call, offline banner, alert and tooltip calls, sign-out `clear` and `revoke` effects on the local store and on the server). **Not yet run inside the real desktop window**: that needs the web release deployed and a new desktop build. Not built: smart-sync placeholder files and sync-state overlays.

## 9. Mobile

No mobile code was written. `inaya-mobile` is a separate React Native repository whose existing Business Workspace screens are native; the chat client depends on browser WebCrypto Ed25519/X25519 and IndexedDB, which would need a different key and storage layer on device, with secure-store key custody and a biometric gate. That work could not be verified without a device or emulator here, and the mobile repository is published by its owner over the air, so nothing was pushed to it. CHAT-021, MOBILE-001 and CHAT-023 (mobile chat notifications) are open; the owner has deferred the mobile work for now.

## 10. Database migrations

All additive: new collections and new optional fields, no rename, retype or removal. Indexes are created lazily by each module (idempotent `createIndex`); `scripts/competitive-migrate.mjs --apply` warms five modules ahead of first use and reports honestly when a module does not support it. The dry run and the apply were both run against the development database; every feature flag is unset in the environment.

## 11. Automated test results

Last full run, 2026-10-05, against the real MongoDB, serially: `chat-features`, `chat-protocol`, `chat-routes`, `devices-ransomware-backup`, `gateway`, `gateway-health`, `governance-classification`, `governance-wiring`, `governance`, `sharing-policy`, `sharing-routes`, `sharing-shares`, `notes`, `keys`, `compliance`, `metrics`, `phase8`, `job-reliability`, `tenant-isolation-scan`, `performance`.

**189 tests: 184 passed, 5 failed.** All 5 failures were in `chat-routes` and happened while I deleted throwaway test organizations for a browser check that was running at the same time, which removed organizations that suite was using. `chat-routes` was then re-run on its own: **8 of 8 passed**. No other suite failed.

Also run and green in this stretch of work: `docs-openapi` + `docs-content` (10/10), the SDK suite `custody-sdk/test/competitive.test.mjs` (3/3), the earlier regression for the S3 layer and compliance modules (`s3-compat-*`, `credential-scope`, `compliance-*`, `phase1-shared-framework`, `regulated-export-package`; exit code 0, per-test counts not kept), and a clean production build. Earlier phases ran their own suites when they were committed (gateway agent, webhooks, file requests, file locks, data rooms, office, portal requests, replication); they were not part of this final run.

Known test-environment facts: the Pinata plan limit makes two evidence-exporter tests fail until the plan is upgraded (unrelated to this SOW); the database is 200 ms away from the test machine, so timing-sensitive figures are pessimistic.

Second pass, 2026-10-05 (all green, 170 of 170 across 19 suites plus the three new files): forged read events and removed-participant replay (CHAT-019), local drafts, notification-router chat alerts, embed control, external-guest end to end, retention and legal-hold policy enforcement on delete/overwrite/expiry, step-up authentication, the new workflow triggers and file actions, the docs references, and `cargo test directsync::tests` for the DirectSync BLOCKED state.

## 12. Integration and adversarial tests

The suites above run against the real MongoDB, real HTTP route handlers, real archives for upload checks, real Ed25519 signing for the gateway, the real AWS KMS SDK against a local protocol stub, and a real encrypted-chat client pair. Adversarial coverage by area:

- **Chat**: message/commit substitution and replay, rogue add/remove, stale epoch, cross-tenant access, attachment tamper, malformed and oversized input, plaintext leakage into logs and notifications. Not covered yet: forged read events and a few removal races (CHAT-019 is PARTIAL).
- **Sharing**: tampered, truncated and cross-share session tokens; expired and exhausted links; the legacy endpoint cannot bypass a v2 link's rules; nothing sensitive stored or returned in lists or logs.
- **Gateway**: replay, wrong signature, clock skew, revoked gateway, token reuse, cross-tenant access, audit gap/forgery, path escape and symlink escape.
- **Compliance/keys**: collectors never invent a pass; environment mismatch, wrong tenant or purpose for a wrapped key, disabled key; no key material in audit.
- **Jobs**: simultaneous claims (exactly one runs), stale takeover, secret redaction.
- **Tenant isolation**: a static scanner over every route group the SOW added (`test/tenant-isolation-scan.test.mjs`). It checks structure; it is not a proof.

## 13. Browser verification

The ledger marks 56 items as exercised in a real browser on a production build (`npm run build`, `next start`), including chat create/send/receive/reload, sharing manager, file requests, locks, notes, governance views, secure viewer and DICOM, devices, gateway view, replication panel, Office integration view and the compliance readiness view (overview, government profile, key configuration, crypto self-test, package download). Items that have a screen but are not marked are listed as IMPLEMENTED_NOT_LIVE or PARTIAL in section 21 with what was not clicked through. The client metrics reporter (OBS-001) is described in its ledger note.

## 14. Performance observations

Measured by `test/performance.test.mjs`, against a database 200 ms away from the machine running the tests, so absolute figures are pessimistic for a deployment next to its database:

- Chat send, whole server path including notification work: p95 about 1.7 s (was about 3.4 s before this work). It is a chain of about 8 sequential round trips; the acknowledgment itself, in a real request where the notification work runs after the response, is about 5. At 200 ms per round trip that is about 1.0 s for the acknowledgment; the 1.5 s target was not met for the whole path in this environment and was not measured on production infrastructure.
- Every list endpoint added by the SOW caps its page size whatever the caller requests.
- The admin dashboard counts event data by grouping: 6000 backup runs and 1500 workflow runs were counted exactly in about 1 s.
- Not measured: chat history paging and encrypted local search in the client, large share inventories, any load test at production scale.

## 15. Security findings

- Found and fixed during the work: a sliding-window rate-limit API misuse in gateway enrollment; `0` intervals falling back to defaults through `||`; Mongo `Binary.length` misread in gateway transfers; a job-lease race (fixed with an atomic claim); `removeEvidence` reporting success when nothing changed; an Outlook add-in launch URI encoded twice; a regression where a customer upload notification category changed.
- The tenant scanner found no route group missing authentication or deriving the organization from the request body.
- Third-party dependencies added: `ts-mls` (MLS), `@aws-sdk/client-kms`. `ts-mls` has not had a formal independent audit. Stated in the chat ADR and repeated here.

## 16. Unresolved risks

1. **Server-managed keys.** The S3/Azure compatibility layer and, by default, its data key are server-managed (envelope encryption, per-tenant, audited). That is not the zero-knowledge model of the browser path, and the customer-managed key option narrows but does not remove it.
2. **MLS library maturity.** Real MLS through an unaudited library; an external review is advisable before relying on it for the most sensitive conversations.
3. **Legacy delete route.** The Business Workspace document delete route was not re-verified against legal hold (GOV-004).
4. **Pre-existing background jobs** were not rewired through the reliability wrapper; only the four added by the SOW were.
5. **Window handoff** takes a few seconds (up to one 15 s update) and relies on the Web Locks API; where it is missing the one-owner guard is skipped.
6. **Metrics catalog** is fixed by design; new metrics need a code change. Client-reported figures exist only when clients report.
7. **No production-scale load or soak test** was run.

## 17. What Inaya still does NOT claim

- Not FIPS 140 validated. The crypto layer is "FIPS-ready": it refuses non-approved algorithms in that mode and reports validation only when the runtime is in FIPS mode and an operator has recorded a certificate reference; it never states validation itself.
- Not FedRAMP authorized or ATO-holding; not certified under any government scheme. The government profile reports technical readiness only. The evidence package is OSCAL-shaped, not validated against the OSCAL schemas.
- Not NIST-published control text: the catalog is an internal base-control list that points to the authoritative publication.
- No claim that screenshots, photographs or screen recordings can be prevented; the viewer states what it does (watermark, no download, no server-side plaintext derivative) and what it cannot do.
- No claim of active-active replication or of a measured RTO beyond the sample-only recovery test.
- No claim of parity with any competitor product; the competitive analyses compare capabilities, not quality.
- No claim that a single SDK or CLI can read chat or notes.
- The mobile surfaces described in the SOW are not delivered (section 9), and the desktop surface is delivered with the limits in section 8.

## 18. Honesty and security checklist (SOW section 59)

| Question | Answer | Basis |
|---|---|---|
| Is all E2EE chat plaintext kept out of server persistence? | YES | server stores ciphertext only; leakage tests assert a secret never appears in storage, logs or notifications (`test/chat-features.test.mjs`) |
| Are all private keys client controlled? | YES for chat device keys (sealed in the browser). NO for the S3/Azure compatibility layer, which is server-managed by design (risk 1) | |
| Are group membership changes cryptographically handled? | YES | MLS commits; the server accepts only commits matching its plan (`chat-protocol`) |
| Can a removed member access new messages? | NO | removal test: the removed device cannot read the next message |
| Can a new member automatically access old messages? | NO | "a person added later cannot read earlier messages" |
| Are attachments protected by normal Inaya permission checks? | YES for chat attachments (participant-only, tamper-detected) | `chat-features` |
| Can a public share bypass organization policy? | NO on the tested paths | `sharing-policy`; the legacy endpoint cannot bypass a v2 link |
| Can an expired link be reused? | NO | expiry test, including an already-open session stopping at expiry |
| Can a share token be substituted across organizations? | NO on the tested paths | tampered and cross-share tokens are refused; the organization comes from the share record |
| Can a DLP rule be bypassed by an alternate route? | NOT KNOWN TO BE on the wired paths (share create/open/download, uploads, S3/Azure store level). The SigV4 routes were not exercised through a real S3 client for DLP; not every legacy route was audited | DLP-003 is IMPLEMENTED_NOT_LIVE |
| Can an admin read E2EE chat plaintext merely because they are an admin? | NO | the server holds no plaintext or keys. An admin can manage participants and revoke devices; adding oneself gives access to later messages only, and the roster shows it |
| Are device revocation actions enforced server-side? | YES | revoked devices are refused on every chat call; key packages and welcomes are deleted |
| Can a gateway be rebound to another tenant? | NO | the organization comes from the gateway record; enrollment tokens are single use with proof of possession |
| Can a customer-supplied org ID override API-key scope? | NO | the public API resolves the organization from the key; another organization's key sees nothing |
| Can retention/legal hold be bypassed through S3/Azure compatibility routes? | NO at the store chokepoint, tested (including batch operations). The Business Workspace delete route was not re-verified | GOV-004 PARTIAL |
| Can a client write directly around the governance layer? | NOT through the supported routes; not proven for every legacy route | |
| Do all background jobs remain tenant scoped? | YES for the jobs added by this SOW; pre-existing jobs were not reviewed | `job-reliability` |
| Are all new webhooks signed and replay protected? | YES | HMAC signature with timestamp and event id (`docs/api/webhook-verification.md`) |
| Are notification payloads privacy-safe? | YES | generic text for chat and for e-mail, push and webhook channels |
| Is screenshot protection described honestly? | YES | DRM-003 guarantee text and `docs/architecture/drm-viewer-security.md` |
| Is FIPS language honest? | YES | section 17 |
| Is FedRAMP language honest? | YES | `docs/compliance/fedramp-readiness-boundary.md` |
| Are government certification claims absent unless externally authorized? | YES | none made |
| Are public DePIN and enterprise storage routing capabilities still described accurately? | NOT RE-AUDITED in this work; nothing was changed in that code or its descriptions | |

## 19. Operations

Rollout and rollback: `docs/runbooks/competitive-rollback.md`. Metrics and performance: `docs/architecture/observability-and-performance.md`. Gateway: `docs/runbooks/gateway-deployment.md`. Devices: `docs/runbooks/device-revocation.md`. Chat: `docs/runbooks/secure-chat.md`. Ransomware recovery: `docs/runbooks/ransomware-recovery.md`.

## 20. Test commands

```bash
node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-concurrency=1 --test-timeout=600000 test/<file>.test.mjs > log 2>&1
node scripts/competitive-ledger.mjs summary
node scripts/competitive-ledger.mjs check
```

Run the suites serially (shared database) and read the log after the run; do not pipe the runner through `tail`.

## 21. Item ledger

| ID | Status | Automated tests | Browser | Security reviewed | Note |
|---|---|---|---|---|---|
| CHAT-001 | VERIFIED | test/chat-protocol.test.mjs, test/chat-routes.test.mjs | yes | no | Real MLS; tests pass; real-browser round trip with a separate Node device. Web only so far. |
| CHAT-002 | IMPLEMENTED_NOT_LIVE | test/chat-protocol.test.mjs | no | no | Group create/add/remove/leave tested against the real DB; browser pass covered 1:1 only. |
| CHAT-003 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs | no | no | Org-wide conversation tested (admin only); not browser verified. |
| CHAT-004 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs, test/desktop-chat.test.mjs | no | no | External guests, end to end against the real database: refused while the organization policy is off, a stated purpose is mandatory, the guest must accept, then a guest in another organization joins the encrypted group and messages flow both ways. Not run throu |
| CHAT-005 | IMPLEMENTED_NOT_LIVE | test/chat-protocol.test.mjs | no | no | Ids, owner/admin roles, epoch, encrypted title (rename/meta) tested. |
| CHAT-006 | IMPLEMENTED_NOT_LIVE | test/chat-protocol.test.mjs, test/chat-features.test.mjs | no | no | Unread, last-focus, mute, archive, leave, delete-for-me/for-everyone tested. |
| CHAT-007 | VERIFIED | docs only | no | no |  |
| CHAT-008 | VERIFIED | test/chat-protocol.test.mjs, test/chat-routes.test.mjs | no | no | Identity-bound KeyPackages, single use + last resort, revoke, rogue add/remove refused. |
| CHAT-009 | VERIFIED | test/chat-protocol.test.mjs | no | no | Removed member and revoked device cannot read next message; new member gets no history; sends wait for removal. |
| CHAT-010 | IMPLEMENTED_NOT_LIVE | test/chat-protocol.test.mjs, test/chat-features.test.mjs, test/desktop-chat.test.mjs | no | no | Send/edit/delete/idempotency/offline outbox/retry tested; local drafts now kept per conversation in the sealed device store (never sent to the server, erased with history). Draft restore not clicked through in a browser. |
| CHAT-011 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs | no | no | Presence, appear-offline, typing TTL tested server side; UI not fully browser verified. |
| CHAT-012 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs | no | no | Local search over decrypted cache tested; search box not browser verified. |
| CHAT-013 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs | no | no | A Document button opens a picker that searches only documents the person can already open (existing unified search) and attaches a reference (id, name); recipients still need their own access. Built and bundled; not clicked in a browser. |
| CHAT-014 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs, test/chat-routes.test.mjs | no | no | Encrypted upload/download, tamper detection, participant-only tested. Browser file picker bug found and fixed; re-verification pending. |
| CHAT-015 | IMPLEMENTED_NOT_LIVE | test/desktop-chat.test.mjs | no | no | Image previews decrypt on the device; the author can hide or show previews of their own message for everyone through an encrypted control message (tested: author only, no content change, ignores edit policy). UI button not clicked in a browser; image preview i |
| CHAT-016 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs, test/desktop-chat.test.mjs | no | no | New-message alerts go through the notification router: in-app by default, e-mail and webhook only if the person opts in, always generic (tested: no sender/title/text). Desktop alerts built. Mobile push is part of the deferred mobile work. |
| CHAT-017 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs, test/chat-routes.test.mjs | no | no | Long-poll and SSE tested over the real routes; polling fallback is the plain sync route. |
| CHAT-018 | IMPLEMENTED_NOT_LIVE | test/chat-routes.test.mjs | no | no | 29 routes under /api/orgs/chat; flag, auth, device header, error mapping tested; not every route has its own test. |
| CHAT-019 | VERIFIED | test/chat-protocol.test.mjs, test/chat-features.test.mjs, test/chat-routes.test.mjs, test/chat-adversarial-2.test.mjs | no | yes | Adversarial coverage now complete: substitution, replay, rogue add/remove, stale epoch, cross-tenant, attachments, malformed/oversized, leakage, forged read events (clamped, per caller, outsiders refused) and replay by a removed participant (nothing served pas |
| CHAT-020 | PARTIAL | none | yes | no | 3-column UI works in a real browser (create, send, receive, reload restore). Group, attachments, contacts panel, mobile width still to verify. |
| CHAT-021 | PLANNED | none | no | no | Mobile screens not started. |
| CHAT-022 | IMPLEMENTED_NOT_LIVE | test/desktop-chat.test.mjs | yes | yes | Desktop (inaya-desktop, the Business Workspace app; the wallet dApp app is not a chat surface). Built: standalone chat window button, one-owner-window guard with handoff, native alert + tray tooltip (count only), desktop device identity (Desktop app / windows/ |
| CHAT-023 | PLANNED | none | no | no | Mobile push notifications for chat. Part of the mobile work, which the owner deferred for now; nothing built. |
| CONTACT-001 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs, test/chat-routes.test.mjs | no | no | Request/accept/deny/cancel tested; contacts panel not browser verified. |
| CONTACT-002 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs | no | no | Remove/block/unblock tested. |
| CONTACT-003 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs | no | no | Presence privacy and appear-offline tested. |
| CONTACT-004 | IMPLEMENTED_NOT_LIVE | test/chat-features.test.mjs | no | no | Org search only; no cross-org enumeration; external is opt-in and purpose-bound. |
| NOTE-001 | VERIFIED | test/notes.test.mjs | yes | no | Browser-verified 2026-10-04: Markdown (live preview), checklist, rich text (paste and markup sanitized), plain text; code type covered by tests only. |
| NOTE-002 | VERIFIED | test/notes.test.mjs | yes | no | Create, edit, autosave, trash/restore/permanent delete, retention purge (cron /api/cron/notes-purge), history list and restore verified (restore recovered a tampered latest version in the browser). Archive/pin/favorite logic tested; pin/archive buttons not cli |
| NOTE-003 | VERIFIED | test/notes.test.mjs | yes | no | Append-only history, restore as new version, revision bound to position by AAD (swap detected), newest 200 kept. |
| NOTE-004 | VERIFIED | test/notes.test.mjs | yes | no | Pin/favorite/archive/tags live in the encrypted per-user index with compare-and-set across devices. Browser: tag create/assign verified; pin, favorite, archive logic covered by tests. |
| NOTE-005 | VERIFIED | test/notes.test.mjs | yes | yes | Server holds ciphertext only (verified in the DB and in the API response from the browser). Passphrase vault, per-note key sealed per participant, AAD-bound revisions. Not independently audited. |
| NOTE-006 | VERIFIED | test/notes.test.mjs | yes | yes | Share (read/edit), key rotation on removal, leave, explicit conflict panel, fingerprint pinning. Browser: share and remove (key v2) verified; the recipient side was verified by tests, not in a second browser session. |
| NOTE-007 | IMPLEMENTED_NOT_LIVE | none | yes | no | Verified by hand in the browser only (attach from composer, encrypted send, Open link, deep link); no automated test yet. |
| SHARE-001 | VERIFIED | test/sharing-shares.test.mjs, test/sharing-routes.test.mjs | yes | yes | Browser-verified 2026-10-04 on a production build: create link with password, wrong password refused, correct password opens v2 viewer. scrypt + lockout. |
| SHARE-002 | IMPLEMENTED_NOT_LIVE | test/sharing-policy.test.mjs, test/sharing-shares.test.mjs, test/sharing-routes.test.mjs | no | no | Server logic tested against the real DB; max-openings counted in browser. Flag-gated (FEATURE_ADVANCED_SHARING, default off). Honest limit: view-only is a viewer mode, revocation cannot recall downloaded bytes. |
| SHARE-003 | IMPLEMENTED_NOT_LIVE | test/sharing-policy.test.mjs, test/sharing-shares.test.mjs, test/sharing-routes.test.mjs | no | no | Server logic tested against the real DB; max-openings counted in browser. Flag-gated (FEATURE_ADVANCED_SHARING, default off). Honest limit: view-only is a viewer mode, revocation cannot recall downloaded bytes. |
| SHARE-004 | IMPLEMENTED_NOT_LIVE | test/sharing-policy.test.mjs, test/sharing-shares.test.mjs, test/sharing-routes.test.mjs | no | no | Server logic tested against the real DB; max-openings counted in browser. Flag-gated (FEATURE_ADVANCED_SHARING, default off). Honest limit: view-only is a viewer mode, revocation cannot recall downloaded bytes. |
| SHARE-005 | IMPLEMENTED_NOT_LIVE | test/sharing-policy.test.mjs, test/sharing-shares.test.mjs, test/sharing-routes.test.mjs | no | no | Server logic tested against the real DB; max-openings counted in browser. Flag-gated (FEATURE_ADVANCED_SHARING, default off). Honest limit: view-only is a viewer mode, revocation cannot recall downloaded bytes. |
| SHARE-006 | IMPLEMENTED_NOT_LIVE | none | yes | no | By-me list, create, status badge verified in browser; with-me / whole-org tabs and access-log dialog not clicked through. |
| SHARE-007 | IMPLEMENTED_NOT_LIVE | test/sharing-policy.test.mjs, test/sharing-shares.test.mjs, test/sharing-routes.test.mjs | no | no | Server logic tested against the real DB; max-openings counted in browser. Flag-gated (FEATURE_ADVANCED_SHARING, default off). Honest limit: view-only is a viewer mode, revocation cannot recall downloaded bytes. |
| REQ-001 | VERIFIED | test/file-requests.test.mjs | yes | yes | Browser-verified 2026-10-04: owner creates request (passphrase), visitor uploads from public page, owner unlocks and saves; 2050 bytes round-tripped exactly. Sealed-box ECDH P-256 + HKDF + AES-256-GCM in browser. |
| REQ-002 | PARTIAL | test/file-requests.test.mjs | no | no | Extension/risky-type/size/count/rate limits enforced and tested. Antivirus scan and classification hooks are NOT possible on end-to-end encrypted uploads; documented on the page and in the UI. |
| REQ-003 | VERIFIED | test/file-requests.test.mjs | yes | no | Owner view shows count/expiry/uploader; filename hidden until passphrase unlock (verified in browser). |
| LOCK-001 | VERIFIED | test/file-locks.test.mjs | yes | no | Browser: lock shown in document Share panel as mine with Renew/Unlock; atomic acquire, lease expiry, force-break, stale sweep covered by 9 tests. |
| LOCK-002 | IMPLEMENTED_NOT_LIVE | test/file-locks.test.mjs, test/workflow-file-actions.test.mjs | no | no | Enforced at the S3/Azure store chokepoint (put/delete/lifecycle) and the new-version route (423). DirectSync now maps a server refusal for a locked, held or retention-protected file to a distinct BLOCKED state with the server's explanation (cargo tests 2/2), s |
| GOV-001 | VERIFIED | test/governance-classification.test.mjs | yes | no | Typed fields, built-ins, sets, manager-only visibility, read-only system fields; saved from the document panel in the browser. Never exposed through share links. |
| GOV-002 | VERIFIED | test/governance.test.mjs | yes | yes | Versioned, immutable once published, second-admin approval, scope/precedence/dates, audit trail. Created and published from the UI in the browser. |
| GOV-003 | PARTIAL | test/governance-retention.test.mjs | no | yes | Published retention policies (object kept until it is N days old, within scope) and legal-hold policies with blockDeletion, plus the permanent retention class, are now enforced on delete, in-place overwrite and lifecycle expiry, on top of the existing per-obje |
| GOV-004 | VERIFIED | test/chat-adversarial-2.test.mjs | no | yes | The Business Workspace API has no destructive document route (the only DELETE removes a permission grant; the only removal is a reversible archive transition that touches no bytes), asserted by a scan test. S3/Azure store enforces holds at its chokepoint. |
| CLASS-001 | VERIFIED | test/governance-classification.test.mjs | yes | no | Metadata, content, PII and term rules; highest sensitivity wins; explanation, confidence and rule versions recorded. Browser: rule suggested CONFIDENTIAL, accepted. |
| CLASS-002 | IMPLEMENTED_NOT_LIVE | test/governance-classification.test.mjs | yes | no | History, suggestions, accept/reject, manual override with mandatory reason that blocks automation, explicit reclassification: all tested. Browser exercised history and accept; the override form was not clicked. |
| CLASS-003 | PARTIAL | test/governance-classification.test.mjs | no | no | Client verdict API validates rule ids and records source client; the evaluator is shared pure code. There is no browser or scanner UI that runs it yet, and no customer scanner agent. |
| CLASS-004 | PARTIAL | test/governance-classification.test.mjs | no | no | Goes through the existing docIntelligence classifyWithAi (AI Security Gateway), suggestion-only, confidence capped. Tested with an injected classifier; live model call not exercised. |
| DLP-001 | VERIFIED | test/governance.test.mjs | yes | no | Every context field the SOW lists is matched by a pure evaluator. Browser: simulator and a live refused share open. |
| DLP-002 | IMPLEMENTED_NOT_LIVE | test/governance.test.mjs, test/stepup.test.mjs | no | yes | ALLOW, DENY, REQUIRE_APPROVAL, LOG_ONLY, QUARANTINE and now REQUIRE_STRONGER_AUTH are real: a person with an authenticator app confirms a fresh code (POST /api/orgs/step-up), which opens a 10-minute window; wrong codes are limited and lock out, a used code can |
| DLP-003 | IMPLEMENTED_NOT_LIVE | test/governance-wiring.test.mjs | yes | no | Enforced on share creation/open/download (browser-verified live) and S3/Azure uploads and downloads (store level tested; the SigV4 routes were not exercised through a real S3 client). |
| DLP-004 | VERIFIED | test/governance.test.mjs | yes | no | Structured events with rule, policy version, masked IP; listed via the API in the browser. |
| UPLOAD-001 | IMPLEMENTED_NOT_LIVE | test/governance.test.mjs, test/governance-wiring.test.mjs | no | no | Extension, MIME sniffing, size, volume, hash block list, zip bomb/nesting/entries/encrypted/unsafe path checks, all tested with real archives. |
| UPLOAD-002 | PARTIAL | test/governance.test.mjs | no | no | Existing scanner (static checks, EICAR, optional ClamAV/Cloudmersive) runs on S3/Azure writes with quarantine-style refusal. End-to-end encrypted uploads can only get metadata checks. No external AV engine is configured in this environment. |
| DRM-001 | VERIFIED | test/vdr2.test.mjs | yes | no | Browser: restricted view with dynamic watermark (visitor, org, UTC time), context menu and copy blocked, blur hides content, watermark restored after removal. View-only mode shares the same code path; the share-link viewer (V2Viewer) was rewired to it but not  |
| DRM-002 | VERIFIED | test/vdr2.test.mjs | yes | yes | Short per-open views that expire, session expiry, immediate revoke, pinned document rows with explicit replacement, access log incl. viewer signals (seen in the browser log). The on-screen expiry wipe was tested by code path, not waited out. |
| DRM-003 | IMPLEMENTED_NOT_LIVE | none | yes | no | The guarantee text is on screen in the viewer and in the doc; no server-side plaintext derivative exists (decrypt happens in the browser). |
| RANSOM-001 | PARTIAL | test/devices-ransomware-backup.test.mjs | yes | no | Signals, scoring with rule and confidence, tripwire, containment (writes refused through putS3Object), admin alert, evidence via the audit chain, resolve/lift and rollback planning verified. Rollback execution tested with a fake store only; no impossible-trave |
| ENDPOINT-001 | PARTIAL | test/devices-ransomware-backup.test.mjs | yes | no | Profiles (folders, include/exclude, schedule, bandwidth, version retention, mirror needs confirmation), pause/resume and client config verified in the browser and tests. The desktop app does not read these profiles or report runs yet. |
| ENDPOINT-002 | PARTIAL | test/devices-ransomware-backup.test.mjs | no | no | Health states, integrity verification against stored objects, point-in-time restore plans, ransomware-safe approval flow and recovery report are tested (storage replaced by an in-memory fake). Restores are executed by the desktop client, which is not built; no |
| DEVICE-001 | VERIFIED | test/devices-ransomware-backup.test.mjs | yes | yes | Browser: this browser checked itself in, inventory and admin summary shown. Masked IP retention purge and device ownership tested. Desktop and mobile clients do not call the check-in yet. |
| DEVICE-002 | VERIFIED | test/devices-ransomware-backup.test.mjs | yes | yes | Browser: app-data wipe executed at check-in (marker cleared, device id kept); block ended the session at once. Trust policy and the central requireMembership gate tested. Wipe is application data only. Desktop/mobile clients do not obey commands yet. |
| SEARCH-001 | PARTIAL | test/phase8.test.mjs | yes | yes | Tier B (permissioned enterprise content): names, paths, metadata, classification, your own tags, your shares and requests, data rooms for managers, and role-filtered pages; nothing the caller cannot open is returned. Tier A (E2EE notes and chat) is reported as |
| PREVIEW-001 | PARTIAL | none | yes | no | Browser-verified on real encrypted files: PDF, XLSX, CSV, DOCX, PNG. Markdown renders through the component verified in Notes but its live room test hit a gateway miss; plain text/code, the workspace Preview button and legacy .doc/.xls were not verified. |
| PREVIEW-002 | IMPLEMENTED_NOT_LIVE | none | yes | no | Browser: a real uncompressed 16-bit DICOM rendered with window/level sliders, patient name hidden by default. Compressed transfer syntaxes are refused honestly. Not a clinically validated viewer. |
| INTEGRATION-001 | PARTIAL | test/office.test.mjs | yes | no | Provider-adapter description with an honest status read from the existing Microsoft connection, edit sessions with a short-lived token, lock, base-version check and version verification, Office launch URIs. Sovereign by default: no file content goes to Microso |
| INTEGRATION-002 | IMPLEMENTED_NOT_LIVE | test/office.test.mjs | no | yes | Add-in manifest and task pane, secure-link insertion through the sharing engine (policy enforced, Manage access required), an e-mail block with expiry and reminders that never carries the password, link list, revoke and inspect (never reveals the token). Attac |
| INTEGRATION-003 | PARTIAL | test/office.test.mjs | no | no | Edit sessions use the existing file locks and the existing versions route; finishing is accepted only for a real new version directly after the base. Control plane tested; end-to-end Office editing needs the desktop client and was not run. |
| VDR-001 | VERIFIED | test/vdr2.test.mjs | yes | no | Settings, sections, NDA gate (browser), per-section visitor scope, access expiry capped by the room, bulk add/update/remove, batch and group invites. Templates are the existing feature. |
| VDR-002 | VERIFIED | test/vdr2.test.mjs | yes | no | Watermark and view-only/download per document verified in the browser; lock, final-version pin and refused removal verified in the browser and tests. |
| VDR-003 | IMPLEMENTED_NOT_LIVE | test/vdr2.test.mjs | yes | no | Visitor log (with viewer signals) and room health with warnings seen in the browser. Timeline, questions and the evidence package are tested server-side only; their UI tabs were not clicked. |
| PORTAL-001 | VERIFIED | test/portal-requests.test.mjs | yes | yes | Upload, download, secure form (answers encrypted at rest, reads audited) and hashed agreement items for one customer; status, notes, history and notifications; strict per-customer and per-organization isolation; real encrypted storage and real HTTP handlers te |
| GATEWAY-001 | VERIFIED | test/gateway.test.mjs, inaya-gateway-agent/test/agent.test.mjs | yes | yes | Outbound-only agent: Ed25519 key made on the customer machine (private key stays there, encrypted with a passphrase), one-time enrollment token with proof of possession, every request signed with nonce and clock window, organization taken from the gateway reco |
| GATEWAY-002 | PARTIAL | test/gateway.test.mjs, inaya-gateway-agent/test/agent.test.mjs | yes | no | Filesystem connector with path-escape and symlink protection, metadata listing, bandwidth throttle, offline queue, resumable end-to-end encrypted transfer (restored byte for byte). The smb and nfs types use paths the operating system exposes (UNC path, CIFS or |
| GATEWAY-003 | VERIFIED | test/gateway.test.mjs | yes | no | Modes 1 (cloud managed) and 3 (customer gateway) are real with computed readiness. Mode 2 is reported PARTIAL/NOT_CONFIGURED honestly: customer storage can receive backups but workspace documents still use Inaya-managed storage. Mode 4 (air-gapped) is recorded |
| GATEWAY-004 | VERIFIED | test/gateway.test.mjs, test/gateway-health.test.mjs | yes | yes | Health (status, queue, lag, read failures), forwarded hash-chained audit with server-side verification and anchoring in the organization audit trail, queued commands, revocation, an offline alert once a day, a dashboard tile, and cross-tenant isolation tests ( |
| NETFOLDER-001 | PARTIAL | test/gateway.test.mjs, inaya-gateway-agent/test/agent.test.mjs | yes | yes | Real NTFS ACL reading through icacls (exercised on this Windows machine), NTFS ordering with deny preserved, group membership, exact-match identity mapping with confirm-first suggestions, enforcement that gives owners no back door, mapping health, conflict and |
| HA-001 | PARTIAL | test/ha-replication.test.mjs | yes | no | Active-passive replication profile; state, lag, backlog, RPO exposure, staleness, conflict and corruption measured from the backup engine's real replica records; recovery tests that read a sample back and verify its hash (sample-only timing, never extrapolated |
| COMPLIANCE-001 | VERIFIED | test/compliance.test.mjs | yes | yes | Four states, a technical-readiness profile only: live technical checks (met, not met, unknown), customer-specific authorization recorded by the customer and explicitly not verified, labels checked by a test not to imply certification. Choosing a state does not |
| COMPLIANCE-002 | VERIFIED | test/compliance.test.mjs | yes | no | 251 base controls across the 19 families as an internal curated catalog (not the NIST publication: no enhancements, no FedRAMP parameters) registered with the existing framework engine; implementation, responsibility, owner, evidence (vault, snapshot, link) an |
| COMPLIANCE-003 | VERIFIED | test/compliance.test.mjs | yes | no | OSCAL-shaped SSP plus every section the SOW lists, stable identifiers, linked evidence resources, SHA-256 and a structural self-check. NOT validated against the official OSCAL schema; vulnerability status is reported as not collected. |
| COMPLIANCE-004 | PARTIAL | test/compliance.test.mjs | yes | no | Provider registry, NIST-approved algorithm policy with a refusing fips_ready mode, known-answer vectors checked against two independent implementations, pairwise tests, usage and dependency inventories, FIPS status that never claims validation. Application cod |
| COMPLIANCE-005 | VERIFIED | test/compliance.test.mjs | yes | yes | Enhanced access records (user, role, department, object, action, time, device, masked address by policy, result, policy decision, authorization basis) written into the audit chain for every document read under a government profile, through the real retrieve ro |
| COMPLIANCE-006 | VERIFIED | test/compliance.test.mjs | yes | no | Readiness overview by family, evidence gaps, expired exceptions, live facts, government checks, cryptography and key status, all labelled readiness only. Not wired into the Admin Dashboard tiles. |
| KEY-001 | PARTIAL | test/keys.test.mjs | yes | yes | Provider interface with platform, local and AWS KMS providers; envelope re-wrap of the server-managed layer's data key (platform copy removed); tenant, purpose and environment binding; rotation with versions and retired state; disable switch; operation audit a |
| BRAND-001 | PARTIAL | test/phase8.test.mjs | yes | yes | Logo, favicon, background, title, accent, support URL, terms/privacy text and email header/footer are validated (real image magic bytes, size caps, https URL, plain text only) and shown on share, file-request and data-room pages (share and request pages checke |
| TENANT-001 | VERIFIED | test/tenant-isolation-scan.test.mjs | no | yes | Static scanner over every route group added by the SOW (session or key auth before data access, org id from the session/record, never the body) plus the per-feature cross-tenant tests. Heuristic: it checks structure, it is not a proof; found no gaps. |
| ADMIN-001 | VERIFIED | test/phase8.test.mjs | yes | yes | Additive adminRoles on org_members; owner/admin hold every scope, auditor reads only. Applied to governance, DLP, devices, ransomware, backup, webhooks, data rooms and dashboard. In the browser a deviceAdmin read devices (200), was refused DLP (403) and could  |
| DASH-001 | VERIFIED | test/phase8.test.mjs | yes | no | 19 tiles computed from real records; OK, ATTENTION, NO_DATA, NOT_ENABLED and UNKNOWN states each explained. S3/Azure request usage is UNKNOWN because request counts are not collected; DirectSync run status is not reported to Inaya. |
| NOTIFY-001 | PARTIAL | test/phase8.test.mjs, test/file-requests.test.mjs | yes | yes | 16 events x in-app/email/push/desktop/webhook with per-person preferences; email, push and webhook carry generic text only, the in-app feed keeps detail; share-expiry job notifies once. Fixed a real bug found by the tests: event names contain dots, which Mongo |
| API-001 | VERIFIED | test/phase8.test.mjs | no | yes | Shares, file requests, governance, DLP events, classification, devices and endpoint backup health, org bound to the key, feature flags honoured, same document-access and expiry checks as the app (tests found and fixed a missing check in the first version). Tes |
| SDK-001 | PARTIAL | custody-sdk/test/competitive.test.mjs | no | no | Shares, FileRequests, Governance, Devices, Compliance and Webhooks.verify added. Chat, Contacts and Notes wrappers are intentionally not provided: those are end-to-end encrypted in the client and cannot be a Bearer-key REST wrapper. Not yet released as a new S |
| CLI-001 | PARTIAL | custody-sdk/packages/cli/test/org.test.mjs | no | no | shares, file-requests, devices, governance and backup command groups using an API key only. No chat, notes or contacts commands (E2EE) and no file-request creation; never reads a wallet key. Tested in-process through commander against a stand-in server; the pa |
| WEBHOOK-001 | VERIFIED | test/webhooks.test.mjs, custody-sdk/test/competitive.test.mjs | yes | yes | Signed (HMAC-SHA256 over t.body), SSRF-refused, retries 1/5/15/60/240/720 min then dead letter, auto-pause after 20 failures, 24h secret rotation grace, content stripped, chat metadata opt-in; real HTTP round trip tested; UI create/rotate checked in the browse |
| AI-001 | IMPLEMENTED_NOT_LIVE | test/phase8.test.mjs | no | yes | Seven read-only tools (policies, DLP summary and explanation, classification counts, ransomware status, device summary, backup health) registered with the OS router; role re-checked per tool; requests to change anything or to certify compliance are refused; no |
| WORKFLOW-001 | IMPLEMENTED_NOT_LIVE | test/workflow-file-actions.test.mjs | no | no | Emits file.uploaded, upload_blocked, classified, classification_suggested, dlp_blocked, shared, share_opened plus (new) share_expiring, legal_hold_changed, vdr_accessed and backup_failed at their real emission points. The new four are covered by a constants te |
| WORKFLOW-002 | PARTIAL | test/workflow-file-actions.test.mjs | no | no | action.file_governance now does classify, set_metadata, revoke_shares, set_retention, lock and unlock (tested, permission checked, no delete). Ticket and approval already exist as nodes. Not built: tag (the metadata framework has no org-level tag field) and mo |
| UX-001 | VERIFIED | test/phase8.test.mjs | yes | no | List and grid, filters (all, favorites, pinned, recent, shared with me, locked, legal hold, classification, tag), favorites, pins, personal tags and recents, classification/lock/hold badges; checked in the browser against seeded documents. |
| UX-002 | IMPLEMENTED_NOT_LIVE | test/phase8.test.mjs | yes | no | Admin Dashboard and Webhooks in the navigation by role; the palette finds documents, shares, requests and pages and now also searches the chat history this device holds (local only, shown as 'Secure Chat · this device'). Notes are not searched from the palette |
| MOBILE-001 | PLANNED | none | no | no |  |
| DESKTOP-001 | PARTIAL | test/desktop-chat.test.mjs | no | no | Chat, notes, locks, endpoint backup, device inventory, gateway views and the secure viewer already run inside the desktop window because it hosts the web app; DirectSync, Drive mount, secure link creation and tray already existed natively. Added this pass: cha |
| PERF-001 | PARTIAL | test/performance.test.mjs | no | no | Chat send path cut from about 17 to about 8 sequential database round trips (acknowledgment itself about 5); measured p95 1.7 s for the whole path at a 200 ms database round trip (3.4 s before); every list endpoint caps page size; dashboard tiles over event da |
| RELIAB-001 | VERIFIED | test/job-reliability.test.mjs | no | yes | withJobRun: atomic lease (partial unique index), stale takeover, bounded backoff retries, redacted failures, minimum interval, tenant scoping; the four crons added by this SOW run through it. Crons that existed before the SOW were not rewired. 8/8 against the  |
| OBS-001 | PARTIAL | test/metrics.test.mjs | yes | yes | Fixed-catalog counters (free text can never become a label), live gauges, org endpoint for admins/auditors, a Usage panel on the Admin Dashboard, token-gated platform Prometheus export with no org id or e-mail, client reporter. Browser-verified: a chat message |
| DOC-001 | VERIFIED | test/docs-content.test.mjs, test/docs-openapi.test.mjs | no | no | Every document the SOW names exists; docs-site API (12 new endpoints, regenerated OpenAPI), SDK and CLI references and a Secure Collaboration product page were added; docs tests 10/10. |
| TEST-001 | PARTIAL | test/metrics.test.mjs, test/performance.test.mjs | no | no | Final run 2026-10-05: 20 suites / 189 tests against the real database (chat x3, devices, gateway x2, governance x3, sharing x3, notes, keys, compliance, metrics, phase8, jobs, tenant scan, performance): 184 passed, 5 chat-routes failures traced to my own brows |
| MIGRATE-001 | VERIFIED | test/performance.test.mjs | no | no | Dry run and --apply run against the dev database: 82 collections referenced, all additive; index setup is lazy per module and --apply warms five modules (others create theirs on first use); every flag unset by default. Rollback is a flag switch, documented; no |
| FINAL-001 | PARTIAL | none | no | no | Report written with the 20 required parts and the section 59 checklist. It states that mobile and desktop surfaces are not delivered, which is why the SOW as a whole is not complete. |
