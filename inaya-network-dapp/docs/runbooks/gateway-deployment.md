# Runbook: deploying a Sovereign Gateway

## Before you start

* Turn on **Sovereign Gateway** under Settings, Beta features.
* You need Node.js 18 or later on a machine inside the network, with read access to the folders you will approve.
* The machine needs outbound HTTPS to your Inaya address. **No inbound firewall rule is needed.**

## Steps

1. In Inaya open **Sovereign Gateway**, Gateways, enter a name and choose **Create enrollment token**. Copy it. It works once and expires in 24 hours.
2. On the gateway machine:
   ```bash
   export INAYA_GATEWAY_PASSPHRASE='a long passphrase'
   node bin/inaya-gateway.mjs enroll --url https://YOUR-INAYA --token gwe_XXXX --label "Head office"
   ```
   The agent creates its key pair locally and saves its configuration encrypted. Keep the passphrase in your own secrets store: without it the gateway cannot start.
3. Tell the agent where your directory identities come from: `set directory windows-local` or `set directory file:C:\path\directory.json`.
4. Run it under a service manager: `node bin/inaya-gateway.mjs run` (or `once` from a scheduler).
5. In Inaya, open the gateway, add a **connector** (type, root path as the gateway sees it) and **approved folders** (relative paths). Only these are ever listed.
6. Wait for a heartbeat (30 seconds). The gateway shows ONLINE; choose **List files** to see the listing.
7. Under **Permissions and mapping**, confirm directory accounts are mapped to people. Unmapped accounts give no one access through Inaya.

## Everyday operations

| Task | How |
|---|---|
| See health | Sovereign Gateway, Gateways (status, queue, lag, read failures); Admin Dashboard tile |
| Send a file to Inaya | List files, **Approve transfer**; the agent sends it at its next check-in |
| Restore a transferred file | `inaya-gateway restore <transferId> --out <file>` on the gateway machine |
| Limit bandwidth | `set bandwidthKbps 2000` |
| Change scan or permission-read frequency | `set scanIntervalSeconds 600`, `set aclIntervalSeconds 1800` |
| Check the local audit chain | `inaya-gateway status` (also verify in Inaya, Audit) |
| Stop a lost or compromised gateway | **Revoke** in Inaya. It is refused at its next request. Then remove the machine's configuration. |

## If something is wrong

* **OFFLINE:** the agent is not running or cannot reach Inaya. Check the service, the clock (must be within five minutes) and outbound HTTPS.
* **Requests refused with a signature error:** the machine clock drifted, or the configuration was copied from another machine. Enroll again.
* **A folder shows no files:** the folder is not in the connector's approved list, the root path is wrong as the gateway sees it, or the scan has not run yet (use **Rescan**).
* **A person cannot see a folder:** check Mapping health. They need a mapped account, and the customer's own permissions must allow read. A deny entry wins.
* **Permission read failures:** on Windows the agent uses `icacls`; the service account must be able to read the folder's security descriptor.

## Not provided

Air-gapped operation, a live LDAP/Active Directory source, per-file permissions, and automatic upgrades without a release key you operate.
