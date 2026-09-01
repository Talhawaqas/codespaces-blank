# Inaya Chain-Agnostic Infrastructure — Audit

Pre-implementation audit for the Universal Chain Adapter work. Every claim below is verified directly against the code, not assumed — see the cited file for each one.

## What exists and works today

- **Home chain**: BSC Testnet. Canonical `$INAYA`, canonical staking ledger (`contracts/InayaStaking.sol`). Unchanged by this work.
- **Live spokes**: Ethereum Sepolia, Avalanche Fuji — fully deployed (`deployments/bridge/{sepolia,avalancheFuji}.json`), wired, relayed by `inaya-network-dapp/src/app/api/bridge/cron/{index-events,relay-messages}`. Confirmed live via `scripts/testnet-health-check.js` (read-only bytecode check against real RPCs).
- **Solana Devnet**: program deployed (`76KGt54jrh142nibdFH9BtZHxSu68rrDwxCTp5d98kZn`) **and wired on-chain** — confirmed by a live read of `bridgeConfig` on 2026-08-31: `admin` set, `homeBridgeAddress`/`homeStakingGatewayAddress` match BSC Testnet's real deployed `bridge`/`stakingGateway` addresses byte-for-byte (`deployments/bridge/bscTestnet.json`), `trustedChain(97).isActive = true`, `validatorSet` holds BSC's real 3 validator addresses at threshold 2, and a bridged-`$INAYA` SPL mint exists. **Correction**: `deployments/bridge/solanaDevnet.json`'s notes ("not yet run") were stale — `initialize`/`add_trusted_chain`/`set_home_addresses` were already called by whoever holds the program's original `upgradeAuthority` key (`FF7HjxkCDzfCtPK8p41ELKNV4VZdKapUvTwZj9Y7TPAE`), not the freshly-generated wiring key from this session. No end-to-end message has been sent and executed yet, so this is `MESSAGE`-level (config wired), not `TOKEN_TRANSFER`-level (a real transfer proven) — see `src/lib/chain-adapters/registry.js`.
- **Polygon Amoy**: config-only (`hardhat.config.js`, `inaya-network-dapp/src/lib/chains.js`), genuinely never deployed — deferred for testnet funding.
- **Security primitives, proven on both EVM and Solana**:
  - M-of-N validator threshold, currently 2-of-3 — `contracts/bridge/InayaValidatorSet.sol` / `solana/programs/inaya-bridge-solana/src/state/validator_set.rs`
  - Replay protection — EVM: idempotent-by-messageId `inboundRecords` in `InayaMessenger.sol`. Solana: high-water-mark + 1024-bit sliding-bitmap window, `state/nonce_tracker.rs`
  - Shared chain-agnostic message hash — `contracts/bridge/InayaBridgeTypes.sol`'s `hashMessage()` ↔ `solana/.../src/message.rs`, identical `keccak256(abi.encode(DOMAIN_TAG, sourceChainId, sourceContract, destChainId, destContract, nonce, msgType, keccak256(payload)))` on both sides
  - Trusted-chain/sender registry — `InayaChainRegistry.sol` / `state/trusted_chain.rs`
  - Circuit breakers — `Pausable` + `emergencyPauser` on every EVM bridge contract; `pause`/`unpause` instructions on Solana

## Gaps — what does not exist today

1. **No `ChainAdapter` interface in code.** The pattern above is real and reused per chain, but expressed as "the same Solidity/Rust deployed per chain," never as a formal object with a defined method surface. `contracts/bridge/CHAIN_ADAPTER_INTERFACE.md` (written in an earlier pass this session) documents the pattern in prose only — not executable.
2. **No capability/support-level registry.** `chains.js`'s `CHAINS` map has addresses/RPC URLs; `InayaChainRegistry.sol` has an informational `chainFamily` byte (`FAMILY_EVM = 0`, `FAMILY_SOLANA = 1`) explicitly commented "never branched on inside the messenger/bridge logic itself." Nothing tracks graduated support levels (Discovered → Read-Only → Wallet → Message → Token Transfer → Staking → Full Ecosystem) — a chain either has full addresses configured or it doesn't.
3. **No transport abstraction.** `sendMessage`/`executeMessage` are direct contract calls; `api/bridge/cron/relay-messages/route.js` hardcodes "collect validator sigs via `ethers.js`, submit `executeMessage`." No `CrossChainTransport` interface exists that a future external messaging provider (or a non-EVM transport) could implement instead.
4. **No chain-specific finality model.** Grepped `inaya-network-dapp/src/app/api/bridge/**` for confirmation/finality logic — zero matches. `index-events` treats any indexed `MessageSent`/`MessageExecuted` event as immediately final, regardless of chain reorg risk. Not visible as a live bug only because every currently-live spoke (Sepolia, Fuji) has fast, low-reorg-risk testnet finality.
5. **Wallet connection is not abstracted.** Web has no central `WalletProvider` — `page.js` / `bridge/page.js` call `window.ethereum` directly (EVM-only); Solana support is one bolted-on component (`src/components/bridge/SolanaWalletProviders.jsx`) beside the EVM form, not behind a shared interface. Mobile's `inaya-mobile/src/providers/WalletProvider.js` is explicitly single-chain (`eip155:97` only, per its own header comment) — no per-chain wallet-family selection exists.
6. **Chain metadata is duplicated across three artifacts.** `inaya-network-dapp/src/lib/chains.js` (the real structured registry), `custody-sdk/packages/bridge-sdk/src/chains.js` (a documented-deliberate duplicate), and the chain-ID constants in `contracts/bridge/ChainIds.sol` / `solana/.../src/constants.rs`. A drift-check test now exists for both (`test/ChainIdsSync.test.js`, `bridge-sdk/test/chains-sync.test.mjs`) but none of the three is generated from a single source — the tests only catch drift after the fact.

## What must not change

- The home-chain/staking model — `InayaStaking.sol` remains the single ledger. `stakeFor()` shares bookkeeping with local `stake()`; duplicating a cross-chain staking position is structurally impossible by the existing design, not merely discouraged by convention.
- $INAYA's 30,000,000 supply cap, and every currently-deployed contract address.
- The working BSC↔Sepolia/BSC↔Fuji flows, and the Solana program's current (unwired) deployment state.

## Conclusion

The hard cryptographic and security work (M-of-N validation, replay protection, a genuinely chain-agnostic message hash, trust registries, circuit breakers) is real, proven, and reusable — this is not a "start from zero" problem. What's missing is entirely the *abstraction layer* on top of that proven substrate: a formal adapter interface, a capability-level registry, a transport interface, and chain-specific finality handling. Every implementation phase after this audit wraps the existing, working code behind that abstraction rather than reimplementing it.
