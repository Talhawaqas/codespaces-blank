# Proof of Storage — Fix, Redeploy, Validate

**Dev summary — 2026-08-17**
Scope: `InayaProofRegistry.sol` access-control fix + real Watcher Pioneer upload integration.

---

## 1. What was wrong

`registerMerkleRoot()` in `InayaProofRegistry.sol` had no ownership check. Any wallet could call it for *any* `fileHash`, including a legitimate uploader's own pending file — and since the function's only guard was "already registered" with no update path, that permanently locked the real owner out. There was no way to recover from it.

Separately, the `_node` parameter (which storage node gets credit/blame for hosting a file) was completely unrestricted — anyone could attribute any address as the responsible node, polluting that address's `nodePassCount`/`nodeFailCount` reliability stats with fabricated data.

While investigating, a third, unrelated bug was found: the web dapp's hardcoded contract address (`page.js`) had a single-character checksum typo (`0xbd36...` vs the correct `0xbD36...`). Ethers v6 validates checksums strictly, so this silently broke `registerMerkleRoot` for every real user via the live UI — the call was wrapped in a try/catch that just logged a warning, so nobody would have seen a hard crash, just a quiet "Merkle root registration failed" message. Net effect: **no real registrations existed on the old contract**, only the deploy script's own dummy fixture.

## 2. The fix

`contracts/InayaProofRegistry.sol`:

- `registerMerkleRoot()` now reads `InayaCustody.assets(_fileHash).owner` (the actual source of truth for who uploaded a file) and requires `msg.sender` to match it. A caller with no matching Custody record, or the wrong wallet, gets a clean revert instead of silently stealing the registration slot.
- New `isRegisteredNode` mapping, owner-curated via `setNodeRegistered(address, bool)`. `_node` must be either `address(0)` (the documented "no node assigned yet" case) or a pre-approved address. Consistent with the contract's existing "Path A" centralized-trust model — the same one `verifyChunkProof` already uses — rather than requiring the full staked-node infrastructure (`InayaNodeRegistry`) that doesn't exist yet.

No changes to `InayaCustody` or any other contract.

## 3. Redeployment

Per the SOW, this was a clean redeploy rather than a migration — the old contract had no real data worth preserving (see §1).

| | |
|---|---|
| New `InayaProofRegistry` | `0xEdF431857e92A00420444F27Ad105278b21CEBcB` |
| Paired `InayaCustody` (unchanged) | `0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888` |
| Network | BNB Chain Testnet (chainId 97) |

**References updated:**
- `inaya-network-dapp/src/app/page.js` — hardcoded `proofRegistryAddress` constant (checksum bug fixed as part of this update)
- `.env.local` (`inaya-network-dapp`) and outer `.env` — `PROOF_REGISTRY_ADDRESS` / `NEXT_PUBLIC_PROOF_REGISTRY_ADDRESS`
- `inaya-mobile/src/utils/custody.js` — new `PROOF_REGISTRY_ADDRESS` export (mobile had zero references to this contract before Phase 2)
- `custody-sdk` and `SDK_GUIDE.md` were checked and confirmed to have **zero** existing references — nothing to update there.

## 4. Verification (real transactions, not code review)

`scripts/verify-fix.cjs` — two fresh wallets, real `InayaCustody` registration, real gas, against BSC Testnet:

| Check | Result |
|---|---|
| Front-running (Wallet B registers Wallet A's real fileHash) | ✅ Reverts: `"Caller is not the Custody-recorded owner"` |
| Legitimate owner (Wallet A) registers | ✅ Succeeds, `owner`/`merkleRoot` confirmed correct via `getAssetProof` |
| Unregistered `_node` | ✅ Reverts: `"Node not registered"` |
| Owner-approved `_node` | ✅ Succeeds after `setNodeRegistered` |
| `address(0)` node | ✅ Still succeeds (no-node-yet case) |
| Double-registration (regression check) | ✅ Still reverts: `"Already registered"` |

## 5. Phase 2 — real Watcher Pioneer uploads now register real proof

**Before**: `inaya-mobile/src/screens/UploadScreen.js` registered files in `InayaCustody` only. It never called `InayaProofRegistry` at all — zero references existed anywhere in the mobile app.

**After**: once the Custody registration confirms, the screen now:
1. Reconstructs the full encrypted ciphertext from the two IPFS shards (`shardAlpha + shardBeta`)
2. Builds a Merkle tree over it — `inaya-mobile/src/utils/merkle.js`, a direct port of the web dapp's `src/lib/merkle.js` (same 256KB chunk size, same sorted-pair hashing), so a mobile-registered root is structurally identical to a web-registered one
3. Calls the fixed `registerMerkleRoot()` with the real `fileHash`, root, chunk count, and `address(0)` for the node

This isn't Watcher-Pioneer-specific plumbing — it fires for every upload through this screen, the same way the web dapp already registers a proof root for every file. Watcher Pioneer participants doing real uploads get real, on-chain proof-of-storage data as a natural consequence of using the same shared path, which is what "genuine data tied to real users" means in practice.

**Failure handling**: if the proof-root step fails for any reason, it's caught and logged — the Custody registration and the file itself are already safely done by that point, and the Watcher Pioneer session-qualification hook (`qualifyViaUpload`) fires off the *Custody* transaction hash, not this one, so it's completely unaffected either way.

Verified end-to-end against real infra — `scripts/verify-phase2.cjs` replicates the exact `UploadScreen.js` sequence (real wallet → real faucet funding → real Pinata pin via `/api/upload` → real `InayaCustody.batchRegisterAssets` → real Merkle root → real `registerMerkleRoot`) and confirms every stored field matches.

## 6. What this claim does and doesn't cover

**Accurate to say**: proof-of-storage registration is live and verified — every real upload now produces a real, on-chain Merkle root tied to the actual uploader's wallet, with front-running protection that didn't exist before.

**Not accurate to say**: that the full challenge/verification loop is live. It isn't, and this SOW deliberately didn't build it (out of scope — "Path B", staked nodes, slashing). `verifyChunkProof()` still has no automated caller; `scripts/verify-chunk.cjs` remains a manual, by-hand tool exactly as it was before this work. Nothing currently spot-checks a registered root against what's actually stored on IPFS. That's a separate, larger future initiative.

## 7. Files changed

| Repo | File | Change |
|---|---|---|
| outer | `contracts/InayaProofRegistry.sol` | Ownership check + node allowlist |
| outer | `scripts/deploy.js` | New constructor arg (custody address); removed dummy registration (would now correctly fail without a real Custody record) |
| outer | `scripts/verify-fix.cjs` | New — Phase 1 verification |
| outer | `scripts/verify-phase2.cjs` | New — Phase 2 verification |
| `inaya-network-dapp` | `src/app/page.js` | New contract address (checksum bug also fixed) |
| `inaya-mobile` | `src/utils/custody.js` | New `PROOF_REGISTRY_ADDRESS` + ABI export |
| `inaya-mobile` | `src/utils/merkle.js` | New — ported from web |
| `inaya-mobile` | `src/screens/UploadScreen.js` | Wired in the Merkle root registration step |
