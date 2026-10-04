# Watcher Pioneer Program: social login

People can take part with a **wallet** (as always) or with a **Google account**, and can use both on one account.

## What did not change

Existing wallet participants, their points, their sessions and the older app builds are untouched. The feature is additive:

- No existing record is read differently, rewritten, re-keyed or migrated. No existing index changed.
- The wallet routes behave as before. A request takes the social path only when it carries a Google token **and no wallet signature**.
- Before this shipped, a read-only snapshot of all Watcher data was taken (37 participants, 144 sessions, 67 compensation grants,
  429,400 points) and compared with live data afterwards: nothing missing, nothing altered.

## How it works

| Person | Record they use |
|---|---|
| Wallet participant (existing) | Their wallet-keyed record, as always |
| Google-only participant | The same kind of record, keyed `social:google:<Google account id>` (never equal to a `0x` address). Same 2,500 cap, same 24-hour sessions, same 200 points per session, same 100,000-point lifetime cap, same promo, same compensation tooling, same backups |
| Wallet participant who adds Google | Their Google login is attached to their wallet record. Signing in with Google then opens that same record (same points and sessions) |
| Google participant who links a wallet | The wallet is linked to their record, for the upload qualifying action and for receiving rewards |

The identity is Google's stable account id (`sub`), not the email.

## Rules that protect people

- **No merging, ever.** If a wallet that already has its own account is linked to a Google participant (or a login is attached to a wallet that
  already has one), the link is refused with a clear message. Combining two accounts would mean moving points; that stays a deliberate admin
  decision, not an automatic one.
- **Linking needs both proofs**: a fresh Google token and a wallet signature over a message naming that exact Google account.
- A wallet linked to a Google participant cannot also enroll on its own (it would create a second record for one person).
- Without a linked wallet a Google participant uses the **social task** to start sessions; the **upload** action needs their linked wallet's
  on-chain transaction.
- Rewards are off-chain points either way; paying out INAYA needs a wallet, so Google participants are prompted to link one.

## API (all under `/api/watcher`)

- `POST enroll` / `POST qualify`: send `{ idToken }` (and no signature) for a Google participant.
- `GET status` with `Authorization: Bearer <Google ID token>` (a Google login's status includes its email, so it is not public like the wallet read).
- `POST link` `{ idToken, walletAddress, message, signature, timestamp }`: the message is `buildWatcherMessage({ action: "link_social", extra: { provider, subject } })`.

New collections: `watcher_identities` and `watcher_wallet_links`. Both are included in the Watcher backup.

## Known limits

- Google only for now. Adding another provider is a new verifier in `watcherSocial.js` (`SOCIAL_PROVIDERS`) plus a sign-in button.
- Google's ID token lasts about an hour and is held in memory only. When it expires the app asks the person to sign in again; points and sessions
  are unaffected (they live on the server).
- Not run on a real phone or against real Google here: the server logic and routes are tested with a stand-in for Google's token check, and the
  mobile bundle compiles. A real sign-in on a device is the remaining check.

## Tests

`test/watcher-social.test.mjs` (12 tests, including "existing data is untouched": a legacy-format wallet participant with points, a completed
and an active session is identical, byte for byte, after every social flow, and no index changes).
