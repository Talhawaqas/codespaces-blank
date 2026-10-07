# Threat model: Inaya PQC hybrid key-establishment layer

Companion to `docs/architecture/pqc-architecture-adr.md`. Status: 2026-10-07, pre-implementation.

## Assets

1. PQC device private keys. 2. Hybrid-derived wrapping keys and the content keys they protect. 3. Device key lifecycle integrity
(active vs. revoked). 4. Backward compatibility — existing (pre-PQC) encrypted data must remain decryptable.

## Actors

Same base set as `docs/security/e2ee-chat-threat-model.md` (honest-but-curious server, compromised server, revoked device, malicious
member, other tenant, network attacker, stolen unlocked device), plus: **future quantum adversary** — assumed capable of breaking
classical X25519 key establishment retroactively against ciphertext harvested today, but not assumed capable of breaking ML-KEM-768.

## Threats and mitigations

| # | Threat | Mitigation | Test |
|---|---|---|---|
| T1 | Harvest-now-decrypt-later: adversary records classical-only ciphertext today, decrypts after a cryptographically relevant quantum computer exists | Hybrid envelope's PQC shared secret also protects the wrapping key; breaking X25519 alone is insufficient | crypto-vector: hybrid KDF parity test |
| T2 | Downgrade attack: adversary forces a `PQC_REQUIRED` recipient to accept a `LEGACY_CLASSICAL` envelope | Server and client both reject issuing/accepting a classical envelope when policy requires hybrid; no silent fallback | adversarial test: downgrade rejection |
| T3 | Algorithm substitution: forged envelope claims an unsupported/weaker algorithm ID | Client validates `algorithm`/`version` against a known set before processing; unrecognized value fails closed | malformed-envelope rejection test |
| T4 | Stale/revoked device key still accepted | Revocation checked at issuance time (new sharing to a revoked key fails) and the existing device-revocation workflow applies | revocation integration test |
| T5 | Replayed key envelope reused to re-derive an old wrapping key | Envelope `nonce`/`salt` are fresh per operation; replay of an old envelope re-derives the same key only for data it already protected, not new data | replay rejection test |
| T6 | Private PQ key exfiltrated via logs, URLs, analytics, crash telemetry | Private keys generated and held client-side only, same storage pattern as MLS device keys (OS credential store / `expo-secure-store` / non-extractable Web Crypto key); code review + log-scan test | log/URL scan test |
| T7 | Malformed KEM ciphertext causes a crash or silent wrong-key derivation | `@noble/post-quantum`'s decapsulation is called with input-length/format validation before use; corrupted ciphertext rejected, not silently "succeeding" with garbage | crypto-vector: corrupted-ciphertext rejection |
| T8 | Supply-chain compromise of the PQC library | `@noble/post-quantum` pinned to an exact version (same discipline as `ts-mls` for chat); dependency audit recorded in the ADR | dependency-audit note in ADR |
| T9 | Migration/rollback destroys access to already-PQC-encrypted data | Rollback reads via the compatibility layer; migration never deletes keys or envelope records (SOW §18.2) | migration/rollback test |

## Explicitly out of scope

Breaking the existing BNB Testnet contract-signature scheme (ECDSA) is not addressed by this layer and no claim is made that it becomes
post-quantum-safe (ADR §6). A compromised client device's unlocked session is out of scope the same way it is for every other Inaya
encryption layer — the trust boundary starts at the device, not before it.
