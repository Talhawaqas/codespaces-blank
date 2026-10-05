# Customer-managed encryption keys

Code: `src/lib/keys/providers.js`, `src/lib/keys/service.js`; plugged into the server-managed storage layer in `src/lib/s3-compat/credentials.js`. Route `POST /api/orgs/compliance/keys/*`; screen: Compliance Readiness, Encryption keys. Changes are behind `FEATURE_CUSTOMER_MANAGED_KEYS` (default off). **Only the organization owner can change key management.**

## What is protected

Two kinds of encryption exist in Inaya:

* **Client-side** (workspace documents, chats, notes): the key never leaves the person's device. Key management here does not apply; the platform cannot read this content in the first place.
* **Server-managed** (the S3/Azure-compatible layer): objects are encrypted with a per-organization **data key**, a 48-byte passphrase. By default the data key is wrapped with a platform key held in the deployment's environment.

Customer-managed keys change who wraps the data key. **The key provider only ever receives that small data key, never file content.**

## Providers

| Provider | Where the key lives | Notes |
|---|---|---|
| platform | the deployment environment | the default; unchanged behaviour |
| local | key material the customer's own deployment supplies (`CMK_LOCAL_KEYS`) | for controlled deployments |
| kms | a customer-owned AWS KMS key | Encrypt/Decrypt with an EncryptionContext. Region and optional endpoint are set per organization; credentials come from the deployment's AWS credential chain, so the customer grants the deployment access to their key and can revoke it at any time |

## Envelope encryption and binding

* Every wrap and unwrap is bound to the **tenant** (organization id), the **purpose** and the **environment** through authenticated context (AES-GCM additional data; the KMS EncryptionContext). A blob wrapped for one organization or environment cannot be unwrapped for another, even with the right key. A deployment in a different environment refuses with `ENV_MISMATCH`.
* Switching provider **re-wraps** the data key. Files are not re-encrypted, because the data key does not change. The platform-wrapped copy is removed, so after the switch the platform alone cannot unwrap it. Before anything changes, the provider is exercised with a throw-away probe key; a wrong key reference changes nothing.
* A short-lived in-memory cache (default 60 seconds, `CMK_CACHE_SECONDS`) avoids a key-service call for every object operation.

## Rotation, states, audit

* **Rotate** moves the data key under a new key (or key id). The old version is marked retired and kept in the history. Files are untouched.
* **Disable in Inaya** is a kill switch on this side: the deployment stops using the key and unwrap fails with `KEY_DISABLED`. It does not touch the customer's key. Enabling restores access.
* Every wrap, unwrap, configuration change and failure is recorded in a key audit and, for configuration, in the organization's hash-chained audit trail. **No key material, plaintext or ciphertext is ever written to the audit.** The screen shows 30-day counts and the last failure.

## Destruction and recovery (read this before using a customer key)

* If the customer **destroys, disables or revokes** the key, the data key cannot be unwrapped, and everything the server-managed layer encrypted under it becomes **permanently unreadable** (crypto-shredding). There is **no Inaya-held copy** once a customer key is in use.
* If the key is only **disabled or access-revoked**, re-enabling it restores access; nothing was lost.
* If the key is **scheduled for deletion**, cancel the deletion in the key service before it completes.
* Before relying on a customer key, keep an independent, tested copy of the key (or its backup) under your own recovery procedure, and rehearse a read after rotation.
* To return to the platform key while the customer key still works, choose Platform-managed: the data key is re-wrapped back.

## Limits

* The KMS adapter was tested against a stand-in that implements the AWS protocol and authenticates the EncryptionContext. It was **not run against a live AWS KMS account**.
* Platform key rotation (the environment master key) remains an operator procedure.
* Client-side encrypted content is outside this feature by design.
