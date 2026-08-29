# Inaya Cross-Chain Bridge & Cross-Chain Staking (SOW-1)

Testnet-phase implementation. Home chain: **BSC Testnet**. Spokes: **Ethereum Sepolia, Polygon
Amoy, Avalanche Fuji** (EVM) and **Solana Devnet** (non-EVM). Mainnet, tokenomics changes, and
the 30M supply cap are explicitly out of scope.

## 1. Architecture

Hub-and-spoke. Real `$INAYA` never leaves BSC Testnet — `InayaTokenBridgeHome` locks it and
tracks `lockedBalanceByChain[chainId]`. Every spoke gets a bridge-minted 1:1-backed
representation (`InayaWrappedINAYA` on EVM spokes, an SPL mint on Solana), branded identically
as `$INAYA` in every UI. `InayaStaking.sol` on home is the **one** canonical staking ledger —
a "stake" from any spoke is really: burn/lock there → cross-chain message → home's
`stakeFor()` credits the single ledger. Unstake/claim-to-a-chain is the reverse.

Messages are one of exactly three types, each with a narrow handler:

| msgType | Direction | Purpose |
|---|---|---|
| `TOKEN_MINT` (0) | → any chain | Credit: completed transfer, unstake payout, or reward-claim payout |
| `TOKEN_BURN_NOTICE` (1) | spoke → home only | `PLAIN`: unlock to recipient. `ROUTE`: relay on to a different spoke |
| `STAKE_REQUEST` (2) | spoke → home only | Credit the one canonical staking ledger |

Validity comes from **M-of-N ECDSA validator signatures** (2-of-3 to start), not a single
relayer key — a relayer submits permissionlessly; execution requires threshold signatures from
a registered validator set. The same secp256k1 keys work for EVM and Solana destinations
(Solana verifies via its native `secp256k1_program`, not a separate Ed25519 keyset).

Message hash (identical on every chain, EVM or not):
```
keccak256(abi.encode(DOMAIN_TAG, sourceChainId, sourceContract, destChainId, destContract, nonce, msgType, keccak256(payload)))
```

Chain-id convention: real EVM chainIds as-is (97/11155111/80002/43113); non-EVM chains use the
reserved sentinel range `>= 1_000_000_000` (`SOLANA_DEVNET = 1_000_000_002`). See
`contracts/bridge/ChainIds.sol` / `solana/programs/inaya-bridge-solana/src/constants.rs`.

## 2. Contracts

- `contracts/bridge/ChainIds.sol`, `InayaBridgeTypes.sol`, `IInayaMessageHandler.sol` — shared types
- `contracts/bridge/InayaChainRegistry.sol` — trusted remote chain/contract registry
- `contracts/bridge/InayaValidatorSet.sol` — M-of-N ECDSA threshold verification
- `contracts/bridge/InayaMessenger.sol` — send/execute, replay protection, status tracking
- `contracts/bridge/InayaTokenBridgeHome.sol` / `InayaTokenBridgeSpoke.sol` — lock/unlock vs mint/burn
- `contracts/bridge/InayaWrappedINAYA.sol` — bridge-minted ERC20 on each EVM spoke
- `contracts/bridge/InayaStakingGatewayHome.sol` / `InayaStakingGatewaySpoke.sol` — staking adapters
- `contracts/InayaStaking.sol` — extended (unchanged existing behavior) with `stakeFor`/`withdrawTo`/`claimRewardTo`
- `solana/programs/inaya-bridge-solana/` — Solana counterpart (**written, not compiled in this environment** — see its `lib.rs` doc comment)

## 3. Known Design Decisions (read before assuming a gap is a bug)

1. **Fee buffers.** `$INAYA` charges a flat 0.0001-token fee per transfer. `InayaTokenBridgeHome.feeBufferBalance()`/`topUpFeeBuffer()` and `InayaStakingGatewayHome.feeMargin`/`topUpFeeBuffer()` are owner-funded operational reserves absorbing that fee on internal hops. A starved buffer fails a message to `Failed` status — retryable, not stuck.
2. **`userStakedByChain` is lifetime-inflow only.** It increments on `stakeFor`, never decrements on withdrawal. It's an analytics/breakdown field ("where did your position come from"), not a live per-chain balance — reward math never reads it.
3. **Relayer sponsors destination-chain gas, both directions, testnet phase.** Avoids a "no gas on a chain I've never touched" dead end. Revisit before any mainnet consideration.
4. **New `InayaStaking` deployment, old one untouched.** Ships as `NEXT_PUBLIC_STAKING_ADDRESS_V2`. No migration of existing testnet positions is attempted.
5. **No on-chain ack closing the loop on source-chain status.** The `bridge_transfers` Mongo collection (via `/api/bridge/cron/index-events`) is the actual source of truth the dApp polls, not raw on-chain state on the source chain.
6. **Solana can only originate a stake request, never receive one.** Home is the sole canonical ledger.
7. **Solana always routes through home**, never directly to another spoke — same as the EVM spokes' `bridgeToSpoke`.

## 4. API Reference (`inaya-network-dapp/src/app/api/bridge/*`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/bridge/supported-chains` | public | Chain config list |
| GET | `/api/bridge/transfer-status/[id]` | public | `id` = messageHash |
| GET | `/api/bridge/staking-position/[address]` | public | Live ledger read + origin breakdown |
| POST | `/api/bridge/initiate-transfer` | public | Register a pending transfer after client-side lock/burn tx |
| POST | `/api/bridge/unstake` | public | Register a pending cross-chain unstake |
| POST | `/api/bridge/claim` | public | Register a pending cross-chain claim |
| GET | `/api/bridge/cron/index-events` | `CRON_SECRET` | Scans every chain's Messenger, updates transfer status |
| GET | `/api/bridge/cron/relay-messages` | `CRON_SECRET` | Collects validator signatures, submits `executeMessage` |

## 5. Env Vars

Per-EVM-chain (Sepolia/Amoy/Fuji): `NEXT_PUBLIC_<CHAIN>_RPC` / `<CHAIN>_RPC`,
`NEXT_PUBLIC_BRIDGE_<CHAIN>_ADDRESS`, `NEXT_PUBLIC_INAYA_BRIDGED_<CHAIN>_ADDRESS`,
`NEXT_PUBLIC_STAKING_GATEWAY_<CHAIN>_ADDRESS`, `NEXT_PUBLIC_CHAIN_REGISTRY_<CHAIN>_ADDRESS`,
`NEXT_PUBLIC_MESSENGER_<CHAIN>_ADDRESS`.

Home additions: `NEXT_PUBLIC_STAKING_ADDRESS_V2`, `NEXT_PUBLIC_STAKING_GATEWAY_ADDRESS`,
`NEXT_PUBLIC_BRIDGE_BSC_TESTNET_ADDRESS`, `NEXT_PUBLIC_CHAIN_REGISTRY_BSC_TESTNET_ADDRESS`,
`NEXT_PUBLIC_MESSENGER_BSC_TESTNET_ADDRESS`.

Relayer/validator (server-only): `BRIDGE_VALIDATOR_PRIVATE_KEY_1..N`, `BRIDGE_VALIDATOR_THRESHOLD`.
Reused unchanged: `RELAYER_PRIVATE_KEY`, `CRON_SECRET`, `MONGODB_URI`, `DEPLOYER_PRIVATE_KEY`.

Also used by Hardhat deploy scripts (not dApp env): `VALIDATOR_ADDRESS_1..3`, `SEPOLIA_RPC`,
`POLYGON_AMOY_RPC`, `AVALANCHE_FUJI_RPC`.

## 6. Testing / Deployment

- Contract unit + integration tests: `Test/{InayaChainRegistry,InayaValidatorSet,InayaMessenger,InayaTokenBridge,InayaStakingCrossChain,CrossChainIntegration}.test.js` — run via `npx hardhat test`.
- Local multi-chain dry run: `npx hardhat node --port 854{5,6,7,8}` (see `hardhat.config.js`'s `local{Home,Sepolia,Amoy,Fuji}` entries, each with a genuinely distinct `HH_CHAIN_ID`), then `scripts/deploy-bridge.js` + `scripts/wire-bridge-registries.js` per network, verified end-to-end by `scripts/verify-local-bridge.js`.
- Real testnet deployment needs funded deployer + validator wallets on each of BSC Testnet/Sepolia/Amoy/Fuji (faucets) — not yet performed; flagged as the next external-dependency step.
- Solana: `anchor build && anchor test` once a real toolchain is available (see `solana/programs/inaya-bridge-solana/src/lib.rs`'s doc comment).

## 7. Security Model

| Requirement | Mechanism |
|---|---|
| Replay | `executedMessages`/`NonceTracker` — a completed messageId/nonce can never re-execute |
| Double spend | Lock-before-mint / burn-before-unlock ordering; `totalLocked >= Σ wrapped supply` invariant |
| Duplicate token creation | Wrapped/SPL mint restricted to exactly one bridge minter; real `mint()` never called by bridge code |
| Unauthorized messages | Threshold signatures AND registered trusted-sender check, both required |
| Invalid chain ids | `destChainId == block.chainid` enforced on execution; dest must be registered+active to send |
| Unauthorized contracts | Owner-managed `authorizedSenders`/`handlers` allowlists |
| Duplicate claims | Reward zeroed before the cross-chain call, in the same transaction |
| Manipulated requests | Every routing field is part of the signed hash |

Emergency pause is scoped to cross-chain paths only — local same-chain staking/transfer never
stops.
