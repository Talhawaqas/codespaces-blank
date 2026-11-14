# Inaya Network Security Layer — Dev Summary

Internal team doc. Not committed to git (matches how we've handled other internal-only summaries).

## What it is

A decentralized threat-intelligence and firewall layer integrated into the existing Inaya ecosystem, per `Inaya_Network_Security_Layer_SOW.md` — not a standalone security app. Nodes (mobile/desktop background clients, or the `node-daemon` CLI) submit signed observations about suspicious destinations; the backend reputation-weights independent reporters and, once confidence crosses a threshold, anchors the CONFIRMED verdict on-chain. Individual observations never touch the chain — only verified threats, reputation checkpoints, and policy versions do (SOW §3's core design rule).

## Architecture decision that shaped everything

Off-chain reports, on-chain confirmations only. A node's raw observation is a signed message POSTed to `/api/security/report`, upserted into MongoDB. `computeThreatConfidence()` in `src/lib/security.js` reputation-weights every independent reporter within a 14-day window; crossing `CONFIRM_THRESHOLD_BPS` (7500) triggers exactly one relayer-signed `InayaThreatReporter.confirmThreat()` call. This keeps gas near zero and means a single malicious or brand-new node can never force an on-chain write or a false confirmation on its own — verified live: 4 throwaway nodes with neutral (5000bps) reputation capped out at 52% confidence, well short of the 75% threshold, exactly as designed.

Threat IDs are `keccak256` of the normalized indicator (domain/IP) — the plaintext string never goes on-chain (SOW §5/§15). The backend holds the plaintext↔hash mapping.

## On-chain — 4 new contracts (BSC Testnet, deployed + verified)

- `InayaThreatRegistry` — [0xb374dEA2550B91264335Aa64B73bfFcEc2Db8aDd](https://testnet.bscscan.com/address/0xb374dEA2550B91264335Aa64B73bfFcEc2Db8aDd)
- `InayaThreatReporter` — [0xe22EbADBBBb23A44aF06fAcebbF77D127316450B](https://testnet.bscscan.com/address/0xe22EbADBBBb23A44aF06fAcebbF77D127316450B)
- `InayaNodeReputation` — [0xD2583664DfECA283b045976Cd26eFfAE6189E27A](https://testnet.bscscan.com/address/0xD2583664DfECA283b045976Cd26eFfAE6189E27A)
- `InayaSecurityPolicy` — [0xCE164613A54E45dD7a703A33AA6A9F9d4771976a](https://testnet.bscscan.com/address/0xCE164613A54E45dD7a703A33AA6A9F9d4771976a)

`InayaThreatRegistry`/`InayaThreatReporter` have a circular constructor dependency (registry needs the reporter's address; reporter needs the registry's) — resolved with a placeholder-then-`setReporter()` pattern in `scripts/deploy-security-layer.js`, same idea as other contracts here that needed two-step wiring. Reuses the *same* relayer wallet already funded for the settlement-release cron (`RELAYER_PRIVATE_KEY`) rather than minting a second hot wallet.

`Test/security-layer.test.js` — 17 Hardhat tests (access control, confirm/re-confirm, false-positive override, 4-signer simulated confirmation). All passing.

## Backend — `src/lib/security.js`

Same `getXCollections`/`ensureXIndexes`/`validateXInput` shape as every other lib file in this codebase. Five collections: `security_reports`, `security_threats`, `security_policy`, `security_events`, `security_reputation_cache`. Rate-limited per node (200 reports/day ceiling), deduped per node+threat+day via upsert.

Node reputation is real-time off-chain (accuracy-weighted: confirmed reports raise it, false positives cost 3x as much — same asymmetric-penalty spirit as SOW §19's "reputation decay") and only checkpointed on-chain periodically via a new Vercel Cron (`GET /api/security/cron/checkpoint-reputation`, `CRON_SECRET`-gated, same pattern as the existing settlement-release cron, wired into `vercel.json` every 6h).

Policy starts as a versioned Mongo doc (not a rule-builder UI) — the backend signs the policy hash with the relayer wallet so a client can verify it offline once cached, without a live RPC call (SOW §10).

Routes: public `GET|POST /api/security/{threat,report,reputation/[address],policy,feed,events}`; admin (`isAdminAuthenticated`-gated) `GET /api/admin/security/{threats,nodes}`, `POST /api/admin/security/threats/[id]/override`, `GET|POST /api/admin/security/policy`.

`test/security.test.mjs` — 11 tests against real MongoDB, including a genuine multi-node confidence-aggregation scenario. All passing (140/140 across the whole test suite, no regressions).

## AI — `/api/ai/security-chat`

Direct structural copy of the AI Business Assistant's tool-calling pattern: `explain_threat`, `get_threat_reputation_detail`, `get_recent_security_events` — every tool reads only from verified `security_*` collections, system instruction explicitly forbids inventing evidence, reputation is only ever surfaced in aggregate (never a specific reporting node's address).

## Desktop (`inaya-desktop/src-tauri/src/lib.rs`)

Extended the existing "thin wrapper" pattern rather than adding a native HTTP client crate — a JS `initialization_script` (same idiom as the pending-approvals poller) syncs the confirmed-threat feed and checks link clicks inside the Business Workspace webview. Two genuinely native additions: `notify_security_event` (reuses the existing notification builder) and real OS enforcement — `block_ip`/`unblock_ip` shell out to `netsh advfirewall` (Windows) or `iptables` (Linux, best-effort, degrades to "requires elevated privileges" rather than failing silently). IP-literal-only, never domain-based — resolving a domain first would need separate DNS logic and could disagree with what the browser actually connects to.

**Not compiled locally** — no Rust toolchain in this dev environment. Reviewed manually line-by-line instead of run; a real `cargo build` on a machine with Rust is worth doing before shipping this binary.

## Mobile (`inaya-mobile/src/screens/SecurityScreen.js`)

Deliberately Monitor-scope: no `VpnService`/packet interception. Building that correctly is a separate, high-risk mobile-networking subsystem — done wrong, it silently breaks the user's real internet connectivity on a real device, and the SOW itself frames Android as "investigate" (§11), not "ship." What's real: a live destination checker against the backend, a 5-minute feed sync into a local cache, protection-mode selector (Monitor/Protect/Strict, persisted), local allow/blocklist, recent security events, and an AI Security Assistant panel. Full VPN-based interception is a deliberate, separate follow-up.

## Node daemon (`custody-sdk/packages/node-daemon`)

New `report <indicator>` command, reuses the daemon's existing authenticated wallet keystore as the reporting-node identity rather than inventing a second one — `inaya-node-daemon report evil-example.test --category phishing`.

## Real bugs found and fixed during verification (not just claimed done)

1. **`.env.local` corruption.** A misguided attempt to preserve what I thought was UTF-16 file encoding actually mangled the appended contract-address lines (the file was plain ASCII all along; `file`'s UTF-16 detection was a false positive). Caught because the on-chain confirm call kept silently skipping post-deployment. Diagnosed via raw byte inspection, fixed by truncating the corrupted tail and re-appending in plain text.
2. **Admin override reverted "Unknown threat."** `adminOverrideThreatStatus` always called the registry's update-only `setThreatStatus`, which requires the threat already exist on-chain. A threat an admin wants to confirm may never have crossed the algorithmic threshold — meaning it was never registered on-chain either. Fixed by routing CONFIRMED overrides through the register-aware `confirmThreat` path instead (same function the automatic path uses), and by actually persisting `onChainTxHash`/`onChainConfirmedAt` on a successful override (was missing before).

Both caught via the **real** multi-node simulation script (`scripts/simulate-security-nodes.js`), not assumed — it produced an actual on-chain `confirmThreat` transaction on BSC Testnet: [0x864ac930...](https://testnet.bscscan.com/tx/0x864ac930b397c17482fe660b04011150c3223a5755567f9a5c87a9a62957c35e).

## Admin dashboard

New `/admin/security` page (same passphrase session as the Enterprise Dashboard / Data Room admin) — confirmed/unverified counts, node count, average reputation, a live threats list with a BscScan link per confirmed threat, a node reputation table, and a Confirm/Clear override action. Manually verified end-to-end in-browser: logged in, populated a real threat via the simulation script, confirmed it rendered correctly with the right numbers, cleaned up test data after. Linked from the main `/admin` header alongside a new Data Room quick-link.

## Public transparency page — `/security`

You asked how end users would actually see any of this, and the honest answer at that point was "they don't — everything so far is admin-only or inside the mobile/desktop apps." Added a genuinely public page (no wallet, no login) at `/security`, linked from the main dApp nav ("Security Layer ↗", opens in a new tab, same convention as the Business Workspace/SaaS links):

- **Public-safe stats** — new `getPublicSecurityStats()` in `security.js` + `GET /api/security/stats`. Deliberately aggregate-only (confirmed-threat count, reporting-node count, average reputation) — never raw node addresses or per-report detail, which stay behind `/api/admin/security/*`.
- **Destination checker** — reuses the already-public `GET /api/security/threat`, same endpoint the mobile app and desktop link-checker already call.
- **Recently confirmed threats feed** — reuses the already-public `GET /api/security/feed` (no new route needed there).
- **Ambient network visualization** — `src/components/security/NetworkVisualization.js`, a self-contained `<canvas>` animation (drifting nodes, distance-based connecting lines, occasional red "just confirmed" pulse). No charting/3D library added — plain `requestAnimationFrame`, purely decorative, doesn't touch real data. Sits in the page hero behind the title.

Verified via direct HTTP checks (`curl`) rather than the interactive Browser pane tooling, which was intermittently hanging this session on an unrelated large-webpack-compile/system-load issue (confirmed via server logs showing clean 200s throughout — not a bug in this code). `/api/security/stats` and `/api/security/threat` both returned correct JSON; the rendered HTML included the hero title, the `<canvas>` element, and every section.

## AI Assistant brought to the public page + made prominent

The AI Security Assistant (`/api/ai/security-chat`) had existed since the backend build but had no web UI — mobile was the only place a user could actually talk to it. Added a chat panel to `/security` keyed off a `localStorage`-cached anonymous visitor id (`inaya_visitor_id`, same pattern `page.js`'s activity-ping already used) since this page has no wallet requirement.

First pass buried it as a collapsible near the bottom of the page — user feedback ("Make security assistant AI should be prominent") was direct, so it moved to a flagship, **open-by-default** card right under the hero: gradient-glow border, an "AI-POWERED" badge, and four clickable suggested questions ("What is phishing?", "How does node reputation work?", "How are threats confirmed on-chain?", "What should I do if a site is flagged?") that fire the question immediately on click rather than just filling the input. Verified live — real Gemini answers grounded in the actual threat-confidence/reputation mechanics, not generic security-101 text.

## Page redesign — "less flat, more alive"

Second round of user feedback: the page "felt dull." Addressed without adding any real dependency — pure CSS/Tailwind: a pulsing "● LIVE NETWORK" badge in the hero, icons + a colored top-accent bar + hover-lift on each stat card, and category color-coding (phishing=red, malware=orange, scam=yellow, botnet=purple, spam=blue) with matching icons on both the destination-checker result and the recent-threats feed, replacing what had been plain gray text for every category. Also added three soft blurred ambient background glows behind the whole page.

## Inaya Firewall marketing banner

User supplied a branded marketing banner ("Inaya Firewall — Smarter Protection. Greater Control.") — copied into `public/inaya-firewall-banner.jpg` and placed above the existing hero, wrapped in a button that smooth-scrolls straight to the AI Assistant card on click (`scrollIntoView`). "Inaya Firewall" is the product's marketing name for this same Security Layer system — not a separate feature, worth knowing so future references to either name aren't treated as two different things.

## Known gaps / explicitly deferred (stated up front in the plan, not forgotten)

- Real Android VPN/packet interception — Monitor + in-app link-check only.
- Full dynamic policy-authoring UI — policy is a versioned Mongo doc edited via a raw JSON POST, not a rule builder.
- macOS enforcement — out of scope per SOW §26.
- Recruiting real external security-node operators — the `report` command is the code-side prerequisite; onboarding real operators is a business step.
- Deep packet inspection / traffic content logging — never in scope; only destination-level indicators are ever evaluated.
- Firewall-modifying commands (`netsh`/`iptables`) were written but never executed against a real machine this session — that needs your explicit go-ahead in the moment, per the approved plan.

## Where things live

- Contracts: `contracts/InayaThreat{Registry,Reporter}.sol`, `contracts/InayaNodeReputation.sol`, `contracts/InayaSecurityPolicy.sol` (outer repo root)
- Deploy/demo scripts: `scripts/deploy-security-layer.js`, `scripts/simulate-security-nodes.js`
- Backend: `inaya-network-dapp/src/lib/security.js`, `src/app/api/security/*`, `src/app/api/admin/security/*`
- AI: `inaya-network-dapp/src/lib/ai-security-tools.js`, `src/app/api/ai/security-chat/route.js`
- Admin dashboard: `inaya-network-dapp/src/app/admin/security/page.js`
- Public page: `inaya-network-dapp/src/app/security/page.js`, `src/components/security/NetworkVisualization.js`, `src/app/api/security/stats/route.js`
- Firewall banner asset: `inaya-network-dapp/public/inaya-firewall-banner.jpg`
- Desktop: `inaya-desktop/src-tauri/src/lib.rs`
- Mobile: `inaya-mobile/src/screens/SecurityScreen.js`, `src/utils/securityApi.js`
- Node daemon: `custody-sdk/packages/node-daemon/src/commands/report.js`
- Cron: `inaya-network-dapp/vercel.json` (`/api/security/cron/checkpoint-reputation`, every 6h)
- Contract addresses: local `.env.local` and Vercel production (added by you after deployment)
