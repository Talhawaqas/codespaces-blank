# Inaya Universal Chain Adapter Interface

Multi-chain SOW, Phase 1. This formalizes a pattern that already exists and already works
(BSC Testnet/Sepolia/Fuji are live proof, and Solana's Rust program independently reproduces
the same mechanism) into an explicit, documented contract — so "adding a chain" means
"implement these six things," not "read the EVM code and reverse-engineer what Solana's port
had to figure out on its own."

Every supported chain, EVM or not, implements six things. The contract for each is defined
once here; per-chain implementation notes point at the real, working code that already
satisfies it.

## 1. Chain ID

**Contract**: every chain has exactly one numeric ID, assigned once, never reused.
- Real EVM chains use their real `chainId` as-is.
- Non-EVM chains (no native numeric chain ID) get a sentinel in the reserved range
  `>= 1_000_000_000` — chosen because it can never collide with any real EVM chain ID in any
  foreseeable future, and because this project only ever targets a short, explicit allowlist
  via `InayaChainRegistry` (so even a distant collision is caught at registration, not silently).
- **Single source of truth**: `inaya-network-dapp/src/lib/chains.js`'s `CHAIN_IDS` /
  `SOLANA_DEVNET_CHAIN_ID`. `contracts/bridge/ChainIds.sol` and
  `solana/programs/inaya-bridge-solana/src/constants.rs` mirror it in their own language (a
  cross-language import isn't possible) — kept honest by `test/ChainIdsSync.test.js`, which
  parses all three and fails the build the moment one drifts from the others.

## 2. Wallet Connection

**Contract**: the chain family's native signing scheme, exposed through a `connect()` /
`invokeMethod()`-shaped interface the UI layer can call without caring which family it's
talking to.
- **EVM**: `window.ethereum`-style provider (`eth_sendTransaction`, `wallet_switchEthereumChain`),
  wrapped by `inaya-network-dapp/src/lib/chains.js`'s `ensureChain(provider, chainId)` — the
  one place `wallet_switchEthereumChain`/`wallet_addEthereumChain` logic lives, used by both the
  `/bridge` page's chain picker and `page.js`'s own single-chain `ensureCorrectNetwork()` wrapper.
- **Solana** (the one non-EVM precedent that exists): a parallel, bolted-on provider —
  `inaya-network-dapp/src/components/bridge/SolanaWalletProviders.jsx` — using
  `@solana/wallet-adapter-react`. Validator signatures reuse the exact same secp256k1 keys as
  EVM (Solana verifies via its native `secp256k1_program`, no second keyset) — the wallet
  *connection* differs per chain family, but the *validator authorization* mechanism (§6) does
  not.
- **A future non-EVM chain** (Sui/ICP/Aptos) implements its own native wallet-connection
  component following Solana's shape (isolated provider component, not a rewrite of the shared
  EVM path) — each of those ecosystems has its own standard wallet-adapter convention to build
  against, out of scope until a specific chain is prioritized (see the SOW plan's Phase 3).

## 3. Token Handling

**Contract**: exactly one of two roles per chain, never both.
- **Home** (currently BSC Testnet only): holds real `$INAYA`, locks on outbound
  (`InayaTokenBridgeHome.bridgeOut`), unlocks on inbound burn notice
  (`onMessage` handling `MSG_TOKEN_BURN_NOTICE`). `lockedBalanceByChain[destChainId]` +
  `totalLocked` are the accounting invariant every spoke's wrapped supply must never exceed.
- **Spoke** (Sepolia/Fuji/Amoy on EVM; Solana via its SPL mint): holds a 1:1-backed
  representation, never real `$INAYA`. EVM spokes: `InayaTokenBridgeSpoke.sol` +
  `InayaWrappedINAYA.sol` (sole minter/burner is the bridge contract). Non-EVM: an equivalent
  mint-authority-gated token under that chain's own token standard (Solana's SPL mint, seeded
  `bridged_inaya_mint` — see `constants.rs`'s `SEED_BRIDGED_MINT`).
- There is exactly one home, ever. A new chain is always a spoke.

## 4. Messaging

**Contract**: a chain-family-agnostic message envelope, hashed identically everywhere, so a
signature produced once by a validator is verifiable on any destination chain regardless of
its language/VM.
```
keccak256(abi.encode(DOMAIN_TAG, sourceChainId, sourceContract, destChainId, destContract, nonce, msgType, keccak256(payload)))
```
- **EVM**: `contracts/bridge/InayaBridgeTypes.sol`'s `hashMessage()` + `InayaMessenger.sol`'s
  `sendMessage`/`executeMessage`.
- **Non-EVM**: reproduce the identical 8-field encode + hash in that chain's own language.
  Solana's `message.rs` is the proof this works — same hash, same three message types
  (`TOKEN_MINT`/`TOKEN_BURN_NOTICE`/`STAKE_REQUEST`), same `DOMAIN_TAG` (precomputed once in
  `constants.rs` since Solana has no const-eval keccak syscall). This is the actual mechanism
  that makes "any chain, EVM or not" true rather than aspirational — a future chain's adapter
  work here is "port this one hash function," not "design a new protocol."

## 5. Transactions & Confirmations

**Contract**: a transfer moves through exactly one status lifecycle, tracked off-chain (no
on-chain source of truth for cross-chain status — see the bridge guide's Known Design Decision
#5), surfaced identically to the UI regardless of origin/destination chain.
```
Pending → Confirmed/Completed → Failed (retryable, not stuck)
```
- Source of truth: MongoDB `bridge_transfers` collection, written by
  `api/bridge/cron/index-events` (scans `MessageSent`/`MessageExecuted`/`MessageFailed`) and
  read by `GET /api/bridge/transfer-status/[id]` (keyed by messageHash, chain-agnostic by
  construction — the ID is a hash, not a chain-specific tx reference).
- **EVM indexing**: `ethers.Contract` event filters against each chain's RPC, driven generically
  by `chains.js`'s `CHAINS` map (add a chain there, indexing covers it — no new code).
- **Non-EVM indexing**: does not exist yet for Solana or any other non-EVM chain — the cron
  routes today are ethers.js/EVM-RPC-specific. This is real, unbuilt work (SOW Phase 3/6): a
  parallel indexer implementing the same "watch for the three message-lifecycle events, write
  the same `bridge_transfers` shape" contract using that chain's own log/event mechanism
  (`@solana/web3.js` log subscriptions for Solana, for example).

## 6. Event Indexing / Validator Authorization

**Contract**: M-of-N threshold signatures over the message hash from §4, checked against a
per-chain trusted-sender registry, before any state-changing execution.
- **Validator set**: `contracts/bridge/InayaValidatorSet.sol` (EVM) /
  `solana/.../state/validator_set.rs` + `secp256k1.rs` (Solana) — same validator keys, verified
  via each chain's native signature-recovery primitive (`ECDSA.tryRecoverCalldata` on EVM;
  Solana's native `secp256k1_program` + Instructions sysvar introspection on Solana).
- **Trusted-chain/sender registry**: `contracts/bridge/InayaChainRegistry.sol` (EVM) /
  `state/trusted_chain.rs` (Solana) — owner-managed, no redeploy needed to add a chain, just an
  owner call registering the new chain ID + its trusted contract address.
- **Replay protection**: idempotent-by-messageId on EVM (`InayaMessenger.sol`'s
  `inboundRecords`); a high-water-mark + 1024-bit sliding bitmap on Solana
  (`state/nonce_tracker.rs`) — arguably more robust than the EVM side, tolerant of
  out-of-order delivery within the window.
- **Circuit breaker**: `Pausable` + `emergencyPauser` on every EVM bridge contract;
  `pause`/`unpause` instructions + `bridge_config.paused` checks on Solana.

## Adding a chain against this interface

- **A new EVM chain**: implements every section above by construction — deploy the existing
  contracts (`ChainIds.sol` entry, `deploy-bridge.js --network <name>`,
  `wire-bridge-registries.js`), add one entry to `chains.js`. No new code against this interface;
  see the SOW plan's Phase 2 checklist for the exact per-chain steps (config → fund → deploy →
  wire → validate).
- **A new non-EVM chain**: implements §1 (chain ID) and §4 (message hash) exactly as specified —
  those are language-agnostic by design. §2 (wallet), §3 (token handling), §5 (transaction
  indexing), and §6 (validator/replay-protection primitives) each need that chain's own native
  implementation, following Solana's program as the worked example of "how much of this
  actually ports" rather than starting from a blank page. See the SOW plan's Phase 3 for the
  per-chain scoping this genuinely needs before writing any code.
