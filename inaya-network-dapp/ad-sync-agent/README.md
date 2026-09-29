# Inaya AD Sync Agent

A real, standalone agent you run **inside your own network**, next to your
Active Directory domain controller. It connects OUT to your DC over LDAP
and OUT to Inaya's identity webhook — Inaya never gets a door into your
network, and this agent never accepts an inbound connection from anyone.

This is the piece that was previously listed as **FUTURE / not proven**
in Inaya's Identity Integration SOW ("Active Directory... direct LDAP is
unsupported by design"). It reuses the same webhook, signing scheme, and
lifecycle engine already proven against a real Microsoft Entra tenant —
nothing about the server side changed; this agent is the missing client.

## How it works

1. Binds to your DC over LDAP with a read-only service account.
2. Queries user objects (`objectCategory=person`, excluding computer
   accounts), using AD's own `uSNChanged` update-sequence-number
   attribute for real incremental sync after the first run — the same
   mechanism Microsoft's own AD Connect uses, not a full-directory poll
   every time.
3. Signs each user's data (`HMAC-SHA256`, matching
   `src/lib/identity/normalize.js`'s `verifySignature` exactly) and POSTs
   it to `/api/integrations/identity/webhooks/<providerId>`.
4. Inaya's existing engine (`src/lib/identity/engine.js`) classifies each
   push as a genuine joiner, mover, or leaver on its own — a first-ever
   push for a user is automatically a JOINER, a disabled account is
   automatically a LEAVER, regardless of what this agent sends — so this
   agent does not need to track "have I seen this user before" itself.
5. Saves the DC's `highestCommittedUSN` as a local watermark after a
   fully-successful run. A partial failure does **not** advance the
   watermark, so failed users are retried on the next run rather than
   silently skipped.

## Setup

```bash
cd ad-sync-agent
npm install
```

Create a provider record for your AD tenant first (from the main app,
or `scripts/setup-ad-sync-fixture.mjs` for a local test run) — this
gives you a `providerId` and a `signingSecret` (shown once).

Then set:

| Variable | Example | Notes |
|---|---|---|
| `AD_LDAP_URL` | `ldap://dc01.contoso.local:389` | Use `ldaps://` in production |
| `AD_BIND_DN` | `CN=inaya-sync,CN=Users,DC=contoso,DC=local` | A dedicated, read-only service account — not a domain admin |
| `AD_BIND_PASSWORD` | | |
| `AD_BASE_DN` | `DC=contoso,DC=local` | |
| `INAYA_BASE_URL` | `https://app.inaya.network` | |
| `INAYA_PROVIDER_ID` | | From provider creation |
| `INAYA_SIGNING_SECRET` | | From provider creation — shown once, store it securely |
| `AD_SYNC_WATERMARK_FILE` | optional | Defaults to `./ad-sync-watermark.json` |

## Run

```bash
node src/agent.js
```

This does one pull-and-push pass and exits (code 0 on full success, 1 if
any user failed to push). It deliberately does not daemonize or poll on
its own — run it on whatever schedule you choose (cron, Windows Task
Scheduler, a systemd timer), so your own sync cadence stays visible and
auditable in your own scheduler, not hidden inside this process.

## Security notes

- Use a **dedicated, read-only** AD service account, not a domain admin.
  This agent only reads (`objectCategory=person` search) — it never
  writes to AD.
- The signing secret authenticates this agent to Inaya; treat it like
  any other credential (a secrets manager, not a plaintext file checked
  into source control).
- Nothing about this agent changes Inaya's zero-inbound-connection
  guarantee: Inaya has no network path to reach into your AD forest.
