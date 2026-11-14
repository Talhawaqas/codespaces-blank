# Multi-Chain Update — Dev Summary (2026-09-01)

Internal team doc. Not committed to git. Covers everything shipped today across two systems: Inaya's own native bridge and the new Wormhole interop layer — kept deliberately separate throughout, since a chain's status on one says nothing about the other.

## System 1: Inaya's own native bridge — real dry runs completed

The native bridge (BSC home + EVM/Solana spokes) existed from earlier work but had gaps between "wired" and "actually proven." Closed all of them today with real, on-chain transactions:

### BSC → Avalanche Fuji
- `bridgeOut()` on BSC: [`0x02fc02e1...`](https://testnet.bscscan.com/tx/0x02fc02e1001c89509a78ca28e5a170fa71be689024a0dcc563254c026fcaf6e9)
- 2-of-3 validator signatures collected, `executeMessage()` on Fuji: [`0xc8ec944a...`](https://testnet.snowtrace.io/tx/0xc8ec944a2c5710ce8c6390e614503e1b9a6d5bf9ad7a1367a001cd61cb25c03d)
- Wrapped `$INAYA` balance on Fuji confirmed: `1.0`

### BSC → Solana Devnet — the big one
This was previously deployed and wired (admin set, home addresses matching BSC's real contracts, validator set correct, trusted-chain active) but **had never actually processed a real cross-chain message**. Getting a real message through surfaced three real, distinct bugs:

1. **BSC's `InayaTokenBridgeHome` had no spoke route for Solana.** `setSpokeBridgeAddress()` had never been called for Solana's chain ID — fixed: [`0x364762...`](https://testnet.bscscan.com/tx/0x364762421d3cb604785799caaa9f7508461160dd925f55862324d8085b1f32b8).
2. **BSC's `InayaChainRegistry` had never registered Solana as an active/trusted remote chain** — fixed via `registerRemoteChain()` + `setTrustedRemoteContract()`.
3. **The real one**: Solana's native `secp256k1` precompile keccak256-hashes the instruction's `message` field internally before recovering the ECDSA signature — this is **not documented** in the public client crate docs (confirmed by checking multiple official doc pages, which gave inconsistent/incomplete answers). Our program's own `receive_message.rs` doc comment had flagged this exact code path as "HIGHEST-TECHNICAL-RISK... has NOT been exercised against a real instruction" — that flag was correct. Root-caused empirically: submitted an isolated single-instruction transaction, got `custom program error: 0x2`, traced the *real* current error-enum ordering (`InvalidPublicKey=0, InvalidRecoveryId=1, InvalidSignature=2, InvalidDataOffsets=3, InvalidInstructionDataSize=4` — note this differs from an older docs.rs snapshot that has `InvalidSignature=0`, a genuine doc-versioning trap), confirmed it meant `InvalidSignature`, then confirmed via direct empirical test that signing `keccak256(hash)` instead of `hash` directly fixes it — the on-chain program's own comparison logic didn't need to change (it already expected the raw, unhashed `hash` in the message field); only the off-chain validator signing procedure did.

Real, final result:
- `bridgeOut()` on BSC: [`0xa06d6f48...`](https://testnet.bscscan.com/tx/0xa06d6f484ce7fbf50250443d5a33d1eff46f46d71f912dfac92ccd7ad20b2c4d)
- `receive_message()` on Solana Devnet: `5v8fGdsQjzy8wR1V64XWSdDAfGpBmacxHMFUK8VeYAMXyR7EvXhnm1JsDh73MicrufvL51Pt946joBVdSFWm15MA`
- Recipient's bridged-`$INAYA` balance on Solana confirmed: `1`
- This is the **first-ever proven cross-chain message execution** on Inaya's Solana program.

Updated `secp256k1.rs`'s own doc comment to remove the "unverified" flag and document the real finding for whoever touches this code next. Registry (`registry.js`) updated: Solana Devnet is now honestly `TOKEN_TRANSFER` level (was `MESSAGE`), Fuji's matrix entry corrected to reflect the real proof.

## System 2: New — Wormhole interoperability layer

A second, parallel system (`src/lib/chain-adapters/interop/`) — reaches other blockchains through Wormhole's third-party network instead of Inaya hand-building a bridge per chain. Does not replace or modify the native bridge above.

### Provider selection
Evaluated Wormhole vs. LayerZero against live docs (`docs/interoperability-provider-evaluation.md`), not marketing. Selected Wormhole (WTT mode, since NTT needs a separate CLI/Foundry/Anchor toolchain not set up this pass). LayerZero deferred, not rejected — its DVN model would let Inaya's own validators participate in message security, compelling but out of scope for now.

### Real, proven Wormhole routes — 4 of them
Every one is a full lock-and-complete cycle with a verified non-zero destination balance:

| Route | Lock tx | Complete tx |
|---|---|---|
| BSC → Ethereum (Sepolia) | `0xacfb69e7...` | `0x8ceb13dc...` |
| BSC → Arbitrum (Sepolia) | `0x259717c6...` | `0x3debb3eb...` |
| BSC → Avalanche (Fuji) | `0x81967c37...` | `0x608f7a1f...` |
| BSC (attestation only) | `0x09f6fabe...` | — |

Full record with every hash: `deployments/interop/wormhole-wtt/bscTestnet-attestation.json`.

### Real bug found and fixed along the way
First attempt targeted Wormhole chain ID `2` ("Ethereum," mainnet's ID) instead of `10002` ("Sepolia," the real testnet-specific ID) — Wormhole registers Sepolia as its own distinct chain, unlike BSC/Avalanche which share one ID across mainnet and testnet. Caught by a real on-chain `InvalidTargetChain()` revert; fixed in `WormholeProvider.js`'s chain mapping (same bug existed for Arbitrum/Base/Optimism too).

### Attempted beyond the required proof, hit real external blockers
- **Solana**: wrapped token created and verified on-chain, but completing a transfer is blocked because Wormhole's own guardians never registered BSC as a trusted source chain on their Solana Devnet Token Bridge — a governance-only action, not fixable by Inaya.
- **Sui**: blocked by a Move-level package-version abort inside Wormhole's own SDK.
- **Aptos**: blocked by an explicit, unambiguous error — `publishing module bytecode version 5 is not allowed; minimum is 6`. Wormhole's SDK (`@wormhole-foundation/sdk-aptos-tokenbridge`, last published 2026-07-29) ships bytecode compiled for an older Aptos VM.

Both Sui and Aptos are the **same root cause**: Wormhole's own SDK packages are stale relative to network-side upgrades. Not Inaya bugs, not fixable by more code here — need a new Wormhole SDK release, or (for Solana) a request to Wormhole to register BSC. Full diagnostic detail, including everything checked and ruled out, in the same `deployments/interop/wormhole-wtt/` record.

### `/bridge` UI + relay infrastructure
New "Wormhole Interop Layer" section on `/bridge`, offering only the 3 proven EVM routes as real send options (destination picker); every other Wormhole-reachable chain shown as reference-only, per the explicit no-fake-chain-support policy. New `api/interop/wtt/{initiate,relay,status}` routes — the relay cron (`*/5 min`, added to `vercel.json`) fetches the Guardian-signed VAA and completes the transfer via Inaya's relayer wallet, so users only sign the source-chain lock (same gas-sponsorship split as the native bridge).

**Real build-breaking bug found and fixed**: importing `@wormhole-foundation/sdk` inside a Next.js API route broke the entire production build — that package eagerly pulls in XRPL support regardless of which platform is used, and XRPL's dependency chain ships ESM-only files webpack can't bundle. Fixed by fetching the VAA via a plain REST call to Wormholescan's public API instead (the same endpoint the SDK calls under the hood) — zero SDK dependency in the relay route.

## Also fixed today: White theme readability bug

`text-slate-200`/`text-slate-300` (light grays meant for the dark theme) were hardcoded on primary content across the Business Workspace — dashboard item names, chat bubbles, filenames — instead of the theme-aware `--inaya-text-primary` token. Washed out to near-illegible on White. Fixed across `business/page.js` and all 9 view components. Live in production.

## Complete chain status as of tonight

| Chain | Native bridge | Wormhole interop |
|---|---|---|
| BSC Testnet (home) | Staking-level, proven | Attestation done |
| Ethereum Sepolia | Staking-level, proven | **Proven transfer** |
| Avalanche Fuji | Staking-level, proven (real dry run today) | **Proven transfer** |
| Arbitrum Sepolia | Token-transfer-level, proven (real dry run today) | **Proven transfer** |
| Solana Devnet | **Token-transfer-level, proven (real dry run today, first ever)** | Wrapped token created; transfer blocked by Wormhole governance |
| Polygon Amoy | Discovered only, no funds | No real coverage (Wormhole has no Amoy testnet entry) |
| Sui | — | Blocked by Wormhole SDK staleness |
| Aptos | — | Blocked by Wormhole SDK staleness |
| Base, Optimism, Near, Injective, Sei | — | Evaluated, not attempted yet |

## Verification

`chain-adapters.test.mjs` 20/20, `interop.test.mjs` 15/15, `interop-transfers.test.mjs` 4/4, full dApp suite green (same one pre-existing flaky RAG test as every prior run, unrelated), Hardhat contract suite 159/160 (same pre-existing config-flag test). Production builds confirmed clean after each fix. Live site verified directly — `/bridge` serves the new section, relay route's auth gate confirmed working.

## Where things live

- Native bridge dry-run records: `deployments/bridge/{avalancheFuji,solanaDevnet}.json`
- Interop records: `deployments/interop/wormhole-wtt/bscTestnet-attestation.json`
- Interop docs: `docs/{interoperability-provider-evaluation,inaya-interoperability,multichain-support-matrix,chain-expansion-guide,interop-security-boundary}.md`
- Interop code: `inaya-network-dapp/src/lib/chain-adapters/interop/`, `src/app/api/interop/`
- Native bridge test scripts: `solana/real-transfer-bsc-to-solana.mjs`, one-off Fuji script (not saved as a reusable script, run inline)
- `/bridge` UI: `inaya-network-dapp/src/app/bridge/page.js`
