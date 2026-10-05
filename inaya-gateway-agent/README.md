# Inaya Sovereign Gateway agent

A small agent you run **inside your own network**. It connects **out** to Inaya over HTTPS. It never opens a listening port, so no inbound firewall rule is needed.

## What it does

* **Registers once** with a one-time token from the Inaya admin screen. It makes its own Ed25519 key pair on your machine and sends only the public key. The private key lives in `gateway.json.enc`, encrypted with your passphrase (AES-256-GCM, scrypt), file mode 0600.
* **Signs every request** (Ed25519 over method, path, time, nonce and body hash). Inaya keeps no secret that could be stolen to impersonate the gateway, and a revoked gateway is refused on its next call.
* **Lists the folders an administrator approved** (names, sizes, times, optional SHA-256 for small files). Paths that escape an approved folder, and symbolic links that leave it, are skipped.
* **Reads the folder's permissions on your system** (NTFS ACLs through `icacls` on Windows; owner/group/other mode bits on Linux/macOS, reported as such) and the directory identities you provide, so Inaya can enforce *your* access rules, including deny entries.
* **Keeps a tamper-evident audit log** locally (each event hashes the one before) and forwards it; Inaya re-verifies the chain and anchors its head in the organization's own audit trail.
* **Transfers approved files encrypted end to end.** The file is encrypted here (AES-256-GCM); the key is wrapped with a data key that stays on this machine. Inaya stores ciphertext and an opaque envelope it cannot open. An interrupted transfer resumes from the parts Inaya already holds.
* **Queues work offline.** Listings, permission snapshots and audit batches are written to disk first and removed only after Inaya confirms them.
* **Verifies upgrades.** A package must carry a valid Ed25519 signature from the release key you configured, match its hash and size, and contain only safe paths. The previous version is kept; an unconfirmed upgrade rolls back by itself after two failed starts.

## Install and run

```bash
export INAYA_GATEWAY_PASSPHRASE='choose-a-long-passphrase'
node bin/inaya-gateway.mjs enroll --url https://YOUR-INAYA --token gwe_XXXX --label "Head office"
node bin/inaya-gateway.mjs set directory windows-local        # or file:C:\path\directory.json
node bin/inaya-gateway.mjs once                                # one cycle
node bin/inaya-gateway.mjs run                                 # keep running (use a service manager)
```

Then, in Inaya (Settings, Beta features: turn on *Sovereign Gateway*), open **Sovereign Gateway**, add a connector with a root path and approved folders, and map directory accounts to people.

## Connectors

| Type | What it uses |
|---|---|
| `filesystem` | a local or already-mounted path |
| `smb` | a Windows UNC path or a CIFS mount; **the operating system speaks SMB, this agent does not** |
| `nfs` | an NFS mount |

## Honest limits

* Permissions are evaluated per **approved folder**, not per file.
* Inaya sees only what the gateway reports. Access made directly on your network is not visible to Inaya; access made through Inaya is recorded.
* The directory sources are a JSON file and the machine's local accounts. **A live LDAP / Active Directory source is not included and has not been tested against a domain controller.**
* The local classifier applies simple extension and name rules. It is not the full Inaya classification engine.
* Upgrades need a release key and a release process you operate; this repository ships the verification and rollback, and `scripts/sign-release.mjs` to sign a bundle.
* There is no air-gapped mode.

## Tests

```bash
npm test
```
