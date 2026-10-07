# ADR: Post-quantum key establishment — hybrid layer

Status: accepted 2026-10-07. Scope: Inaya PQC Layer (Internxt-inspired SOW, Workstream A).
Companion: `docs/security/pqc-threat-model.md`.

## 1. Decision

Inaya adds a **hybrid key-establishment layer**: every new PQC-capable key-wrapping operation combines a classical X25519 shared secret
(already used throughout the codebase) with a post-quantum ML-KEM-768 shared secret (FIPS 203), through a domain-separated HKDF. We do
**not** replace AES-256-GCM/XChaCha20-Poly1305 content encryption, and we do **not** write a custom lattice/KEM implementation (SOW §0.13,
§4.7, §19.18-19).

* PQC library: `@noble/post-quantum` (npm, pinned version), the same publisher/ecosystem (`@noble/*`) as every existing crypto primitive
  in `custody-sdk/src/crypto.js` (`@noble/hashes`, `@noble/ciphers`, `@noble/curves`). Pure JS/TS, zero runtime dependencies, works
  identically in browser, Node, React Native, and Tauri webviews — no WASM/native-binding supply-chain surface to audit.
* Parameter set: **ML-KEM-768** (NIST Level 3) as the default and only supported set for v1. ML-KEM-512/1024 are not wired in yet;
  the abstraction is agile enough to add them without touching call sites, but only one set ships until there's a concrete reason for
  another.
* Terminology: internal docs, code comments, and audit records use `ML-KEM-768`/FIPS 203, never "Kyber 512" — Internxt's marketing name
  is not the standardized identifier (SOW §4.2).

Internxt's own marketing describes "Kyber 512" protecting file encryption directly. That is not what we build: Kyber/ML-KEM is a
**key-encapsulation mechanism**, not a content cipher. Our hybrid KEM protects **key establishment and wrapping**; AES-256-GCM remains
the content-encryption primitive for files, exactly as today.

## 2. Hybrid construction

**Revision note (2026-10-07):** this section originally specified `@noble/post-quantum`'s own bundled hybrid combiner
(`KitchenSink_ml_kem768_x25519`, in `hybrid.js`) to avoid hand-rolling the combination. That module turned out to hard-require
`@noble/curves` 2.x (confirmed: it imports `afunction` from `@noble/curves/utils.js`, an export that does not exist in 1.x). This SDK's
existing `@noble/curves` dependency — and every wallet/signing code path elsewhere in the dApp built on it — is pinned to 1.9.7;
`npm run build` caught a real runtime failure (`"curve" expected object, got type=undefined`) in an unrelated AI-wallet route once both
curve versions coexisted in the same bundle and webpack collapsed them into one. Upgrading the whole app's `@noble/curves` major version
for this one feature was judged far riskier than the alternative below, which the SOW's own §4.12 explicitly anticipates and permits.

The hybrid combination is performed by this codebase's own code, using only the two underlying primitives directly — never a second,
competing implementation of either:

* **ML-KEM-768** — `ml_kem768` from `@noble/post-quantum/ml-kem.js`. This module depends on `@noble/hashes` only (confirmed via its own
  `package.json`), not `@noble/curves` — it has no version conflict with anything else in this app.
* **X25519** — the exact same `x25519` import `custody-sdk/src/crypto.js` already uses for the existing sharing primitive
  (`@noble/curves/ed25519`, pinned at 1.9.7) — no second copy, no version drift.
* **Combiner** — `HKDF-SHA256`, with the info parameter binding a fixed domain-separation label together with both ciphertexts and both
  public keys, so the derivation can never collide with any other HKDF use elsewhere in this codebase, and so tampering with either
  component's ciphertext/public-key material changes the derived key, not just leaves it unauthenticated:

```js
sharedSecret = HKDF-SHA256(
  ikm   = x25519SharedSecret || mlKemSharedSecret,
  salt  = undefined,
  info  = "inaya-pqc-hybrid-v1" || mlKemCipherText || x25519EphemeralPublicKey || mlKemPublicKey || x25519PublicKey,
  length = 32,
)
```

This is not a naive `SHA256(a+b)` — the SOW's one explicitly rejected construction (§4.12): it uses a defined KDF (HKDF, not a bare
hash), real domain separation (a fixed label plus every public component bound into the derivation), and both shared secrets
genuinely contribute to the output. `capabilityInfo()`/`generateKeyPair()`/`encapsulate()`/`decapsulate()` in `provider.js` are the only
functions that touch either underlying primitive directly; nothing else in the codebase imports `ml_kem768` or constructs this
combination independently.

Smoke-verified in this repo (2026-10-07, against the dependency tree exactly as it resolves in the dApp): combined `publicKey` 1216
bytes, `secretKey` 2432 bytes, `cipherText` 1120 bytes, `sharedSecret` 32 bytes; encapsulate/decapsulate round-trips correctly; a wrong
recipient's secret key and a corrupted ciphertext each deterministically yield a *different* shared secret rather than silently
succeeding (ML-KEM's implicit-rejection property, carried through this combiner). The resulting 32-byte `sharedSecret` is used directly
as the AES-256-GCM key-wrapping key for the file/content key being protected — no further application-level KDF step is needed, since
the HKDF expand step above already produces a uniformly-distributed, fixed-length key.

A classical-only recipient (no ML-KEM public key registered) can still be served a `LEGACY_CLASSICAL` envelope (X25519 alone, today's
existing scheme, byte-for-byte unchanged) when org policy allows it. `PQC_REQUIRED` policy rejects issuing a `LEGACY_CLASSICAL` envelope
outright rather than silently downgrading (§4.17).

## 3. Envelope format

`encapsulate()`'s single `cipherText` output (1120 bytes) already internally concatenates both the ML-KEM-768 ciphertext (1088 bytes) and
the X25519 ephemeral public key (32 bytes) — there is no separate classical-ephemeral-key field to carry:

```json
{
  "version": 1,
  "algorithm": "HYBRID-MLKEM768-X25519-HKDF-SHA256",
  "kemCiphertext": "<base64, 1120 bytes>",
  "nonce": "<base64>",
  "wrappedKey": "<base64, AES-256-GCM(sharedSecret, contentKey)>",
  "aad": "<base64>"
}
```

Canonicalization: envelope fields are serialized in this fixed key order before any hash/signature touches them (never relying on JS
object-key iteration order as a cryptographic boundary). `algorithm` and `version` are the two fields every client checks before
attempting to process an envelope; an unrecognized value fails closed (§4.11) rather than guessing.

## 4. Device keys

* Each PQC-capable device generates its own ML-KEM-768 key pair **locally** (same device-local-generation model as the existing MLS
  signature keys for chat — see `docs/architecture/e2ee-chat-key-management.md` §2).
* Private key storage: identical pattern to chat's device key wrapping — OS credential store on desktop, `expo-secure-store` on mobile,
  a non-extractable Web Crypto wrapping key over an IndexedDB blob on web. Never sent to the server, never logged, never in a URL.
* Server-side (`pqc_device_keys`): public key, algorithm ID, device ID, key ID, status (`active`/`revoked`), `createdAt`/`activatedAt`/
  `revokedAt`. No private key field exists in this schema; a write attempting to set one is rejected at the route layer.
* Revocation reuses the existing device-revocation workflow (Competitive Expansion `docs/runbooks/device-revocation.md`): revoking a
  device marks its PQC key `revoked`, new sharing/Meet/backup operations to it fail, and the revocation is one more step in that same
  flow rather than a parallel mechanism.

## 5. Rotation

Rotation re-wraps the key envelope under a fresh device key pair; it never requires re-encrypting the underlying file bytes, since the
PQC layer only ever touches key establishment, never content (§4.18). Supported triggers: scheduled, manual, device replacement,
compromise response.

## 6. What this does not claim

* Existing BNB Testnet contract signatures (ECDSA) are **not** post-quantum-safe, and nothing here changes that or claims otherwise
  (§4.22). Evidence records may reference a PQC operation by stable ID; on-chain commitment hashes are unaffected.
* "Quantum-safe" is never shown in UI unless the client has actually activated the hybrid mode for that specific operation — a device
  with a registered-but-unused PQC key is `PQC Ready`, not "Quantum Safe" (§8.2).
* No claim that two-KEM concatenation is automatically secure merely because two algorithms are combined — the domain-separated HKDF
  construction above is the actual security argument, documented here so it can be reviewed independently of this ADR's prose.

## 7. Rejected alternatives

* **Replace X25519 outright with ML-KEM.** Rejected: breaking migration for every existing sharing envelope, and classical-only legacy
  clients would be locked out entirely rather than served a compatible envelope.
* **A custom hybrid KEM combination/implementation.** Rejected per SOW §4.7/§19.19 — no custom lattice code without an explicit
  cryptographic security review, which is out of scope for this pass.
