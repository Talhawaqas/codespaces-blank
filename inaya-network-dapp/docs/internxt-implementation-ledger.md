# Internxt-inspired expansion — implementation ledger

Living document, updated as each workstream progresses. One row per requirement. `Action`: REUSE / EXTEND / NEW / DEFERRED.
`Status`: per SOW §23 — `VERIFIED` / `IMPLEMENTED_NOT_LIVE` / `PARTIAL` / `CONFIGURED` / `NOT_CONFIGURED` / `UNSUPPORTED` / `DEFERRED` / `FUTURE`.

## Phase 0 — Audit and documentation

| Requirement ID | Capability | Source behavior | Existing Inaya primitive | Action | Code path | Status | Notes |
|---|---|---|---|---|---|---|---|
| P0-001 | Gap analysis | SOW §3.1.4 | — | NEW | `docs/internxt-gap-analysis.md` | VERIFIED | Written this session |
| P0-002 | Feature reuse matrix | SOW §3.1.5 | — | NEW | `docs/internxt-feature-reuse-matrix.md` | VERIFIED | Written this session |
| P0-003 | PQC ADR | SOW §3.1.6 | — | NEW | `docs/architecture/pqc-architecture-adr.md` | VERIFIED | Written this session |
| P0-004 | Meet ADR | SOW §3.1.7 | — | NEW | `docs/architecture/meet-architecture-adr.md` | VERIFIED | Written this session |
| P0-005 | Cleaner ADR | SOW §3.1.8 | — | NEW | `docs/architecture/cleaner-safety-adr.md` | VERIFIED | Written this session |
| P0-006 | PQC threat model | SOW §13 | — | NEW | `docs/security/pqc-threat-model.md` | VERIFIED | Written this session |
| P0-007 | Meet threat model | SOW §13 | — | NEW | `docs/security/meet-threat-model.md` | VERIFIED | Written this session |
| P0-008 | Cleaner threat model | SOW §13 | — | NEW | `docs/security/cleaner-threat-model.md` | VERIFIED | Written this session |

## Workstream A — PQC layer

| Requirement ID | Capability | Existing Inaya primitive reused | Action | Code path | Test path | Status | Notes |
|---|---|---|---|---|---|---|---|
| PQC-A01 | Algorithm-agile PQC provider abstraction | `@noble/*` crypto family already in `custody-sdk/src/crypto.js` | NEW | `custody-sdk/src/pqc/provider.js` | — | — | In progress |
| PQC-A02 | Versioned hybrid envelope + domain-separated HKDF | `hkdf` already imported in `crypto.js` | NEW | `custody-sdk/src/pqc/envelope.js` | — | — | In progress |
| PQC-A03 | Device PQC key registry | Device revocation workflow (Competitive Expansion) | NEW | `src/lib/pqc/deviceKeys.js`, collection `pqc_device_keys` | — | — | Pending |
| PQC-A04 | PQC device key API (register/rotate/revoke) | `requireMembership()` route pattern | NEW route, REUSE auth | `src/app/api/orgs/pqc/devices/**` | — | — | Pending |
| PQC-A05 | Algorithm-agile sharing envelope | `src/lib/chat/conversations.js` existing X25519/XChaCha envelope | EXTEND | `src/lib/chat/conversations.js` | — | — | Pending |

## Workstream B — Cleaner

(rows added as implementation proceeds)

## Workstream C — Meet

(rows added as implementation proceeds)

## Workstream D — Backup reconciliation

(rows added once the formal per-file audit against SOW §5.3 runs)

## Final honesty statement (updated at completion)

Not yet applicable — this SOW is in progress. No "VERIFIED" status above is claimed for anything not actually tested; see each row's
Status column, which defaults to blank/pending until real evidence exists.
