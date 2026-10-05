# Public API v1: administration families

Authenticate with `Authorization: Bearer inaya_...` (an organization API key from Settings). The organization is always the key's own: it cannot be changed from the request. Actions are attributed to the member who created the key. Each family follows the organization's feature switch; a family whose feature is off answers with the same error as the app.

| Method and path | Feature | What it does |
|---|---|---|
| `GET /api/public/v1/shares` | Advanced sharing | List every share. Filters: `status`, `documentId`, `limit`, `before` |
| `POST /api/public/v1/shares` | Advanced sharing | Create a link share (`documentId`, `expiresAt` or `expirationPreset`, `options`) or, with `memberEmail` and `permission`, a share with a member. The link token is returned once |
| `GET /api/public/v1/shares/{id}` | Advanced sharing | Access events for a share |
| `DELETE /api/public/v1/shares/{id}` | Advanced sharing | Revoke |
| `GET /api/public/v1/file-requests` | Advanced sharing | List requests (metadata only) |
| `GET/DELETE /api/public/v1/file-requests/{id}` | Advanced sharing | Inspect (uploads list, no keys) or revoke |
| `GET /api/public/v1/governance/policies` | Governance, DLP or classification (by `type`) | Read policies |
| `GET /api/public/v1/governance/dlp-events` | DLP | Read decisions |
| `GET/POST /api/public/v1/classification/{documentId}` | Smart classification | History; evaluate rules (dry run unless `dryRun: false`) |
| `GET /api/public/v1/devices`, `GET/POST /api/public/v1/devices/{id}` | Device control | Inventory; trust, block, remove, sign out, wipe app data |
| `GET /api/public/v1/endpoint-backup/health` | Endpoint backup | Health overview |
| `GET /api/public/v1/evidence` | none | Tamper-evident trail for one record (existing) |

## What is deliberately not here

* **Secure Chat, Contacts and Secure Notes.** They are end-to-end encrypted with keys that exist only in a person's browser or device. A Bearer key cannot read them, and offering an API that could would break the promise that Inaya cannot read them. Use the apps.
* **Creating a file request.** Its key pair has to be generated in a browser, because uploads are sealed to it and the server (and so an API caller) must never hold the private key. Create requests in the app; list, inspect and revoke them here.
* **File content.** No endpoint returns or accepts document content. Documents are client-side encrypted.
* **Publishing or retiring policies, changing a classification by hand, approving DLP requests, restoring files.** These need a person and, where configured, a second approver, so they stay in the app.

## SDK and CLI

`@inaya-network/custody-sdk` exposes `Shares`, `FileRequests`, `Governance`, `Devices`, `Compliance` and `Webhooks` as thin wrappers over these routes. The `inaya` CLI adds `shares`, `file-requests`, `devices`, `governance` and `backup` command groups that use `INAYA_API_KEY` and `INAYA_BASE_URL`; they never read a wallet private key and never touch file content.
