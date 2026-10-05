# Sovereign Gateway

A small agent (`inaya-gateway-agent/`) runs inside a customer's network and connects **out** to Inaya. Inaya never connects in. Server code lives in `src/lib/gateway/`, the agent API in `src/app/api/gateway/v1/`, the administrator and member API in `src/app/api/orgs/gateway/`, the screen in `src/components/business/gateway/GatewayView.js`. Everything is behind `FEATURE_SOVEREIGN_GATEWAY` (default off).

## Trust model

| Question | Answer |
|---|---|
| Who can talk to Inaya as the gateway? | Whoever holds the gateway's Ed25519 **private key**, which is generated on the customer's machine and stored there, encrypted with the operator's passphrase (AES-256-GCM, scrypt). Inaya stores only the public key. |
| How is a request authenticated? | Each call is signed: `METHOD \n path+query \n timestamp \n nonce \n sha256(body)`. Clock window five minutes, one-use nonce, so a captured request cannot be replayed or altered. No bearer secret exists to steal. |
| How is the organization chosen? | From the gateway record. The request never names one. Every query is filtered by that organization. |
| How does a gateway join? | An administrator creates a one-time enrollment token (24 hours, one use). The agent proves it holds the private key and sends the public key. |
| How is it removed? | Revoke. The next call is refused with `REVOKED`; queued transfers are cancelled; the agent stops. |
| What does Inaya see? | Names, sizes and times of files in **approved folders**, permission snapshots, health, the agent's audit events, and **ciphertext** for approved transfers. |
| What can Inaya not do? | Read transferred file content (the key never leaves the customer), reach the customer network, or act outside approved folders. |

## Data flow

1. **Config.** The agent's heartbeat returns the connectors and approved folders the administrator set, and any queued command (`rescan`, `acl_refresh`, `upgrade`, `rollback`).
2. **Inventory.** The agent lists approved folders (metadata only). Paths with `..` are refused; absolute paths are folded into the folder.
3. **Permissions.** The agent reads each approved folder's NTFS ACL (`icacls`) or POSIX mode bits, plus directory identities. Inaya maps them to members and evaluates them (see below).
4. **Audit.** The agent keeps a hash-chained log. Inaya re-verifies each batch (no gaps, correct previous hash, correct content hash) and anchors the latest head in the organization's own audit trail.
5. **Transfer.** An administrator approves a listed file. The agent encrypts it (AES-256-GCM, key derived per transfer), wraps the key under a data key that stays on its machine, and uploads 1 MB parts, each with its SHA-256. Inaya reports which parts it holds, so an interrupted transfer resumes. The finish call carries a chain hash that Inaya recomputes.

## Permission bridge

* Mapping: a directory account maps to a member automatically **only** on an exact UPN or e-mail match. A name that merely looks similar is a *suggestion* until an administrator confirms it.
* Evaluation follows NTFS order per right: explicit deny, explicit allow, inherited deny, inherited allow. No match means no access. Groups apply through membership (transitively); `Everyone` applies to any identified person.
* Enforcement: listing a folder requires an effective **read**. This applies to owners and administrators too. Administrators manage the connector through a separate inventory view that is recorded in the audit trail.
* Health: unmapped accounts, accounts mapped to people who left, allow/deny conflicts, stale snapshots (over 24 hours), read failures, and recent permission changes.

## Limits, stated plainly

* Permissions are evaluated per **approved folder**, not per file.
* Inaya cannot see access that happens on the customer's own network. Access through Inaya is recorded; the product says so.
* The `smb` and `nfs` connector types use paths the **operating system** exposes (UNC path, CIFS or NFS mount). The agent does not speak those protocols.
* Directory sources are a JSON file and the machine's local accounts. A live LDAP/Active Directory source is not included and was not tested against a domain controller.
* Transfers are single-request files up to 50 MB.
* Signed upgrade packages and rollback are implemented and tested, but no release pipeline or release key exists yet.
* **Deployment modes.** 1 (cloud managed) and 3 (customer gateway) are real. 2 (customer-controlled storage) is partial: customer storage can receive backups, but workspace documents still use Inaya-managed storage. 4 (air-gapped) is **recorded only**: nothing is built or tested for disconnected operation and the product makes no claim.

## Tests

`test/gateway.test.mjs` runs the real agent over real HTTP against the real handlers and MongoDB: signing parity, enrollment, replay and tamper refusal, real `icacls`, inventory limits, audit forwarding and tampering, NTFS evaluation, enforcement, resumable encrypted transfer, cross-tenant isolation, revocation and modes. `inaya-gateway-agent/test/agent.test.mjs` covers the agent's own logic.
