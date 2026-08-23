// src/lib/voteWeight.js
//
// Governance Charter Phase 1: computes a wallet's off-chain voting weight
// for Snapshot-style signal votes, straight from real InayaStaking state --
// no new on-chain contract needed for Phase 1 (that's Phase 2's
// InayaVotingPower/InayaGovernor, see contracts/governance/).
//
// Weight formula matches InayaStaking.earned()'s multiplier exactly:
// staked balance x lock-tier multiplier (Flexible 1.00x / 30-day 1.25x /
// 90-day 1.50x, defaulting to Flexible if no lock was ever set). Kept as a
// pure function + a thin on-chain reader so the same logic can be unit
// tested without a network call, reused by the Snapshot strategy in
// snapshot-strategy/inaya-stake-weight/, and reused server-side if a future
// admin/analytics view needs "what would this wallet's vote weight be."

const BPS_DENOMINATOR = 10000n;
const FLEXIBLE_MULTIPLIER_BPS = 10000n; // 1.00x -- InayaStaking.FLEXIBLE_MULTIPLIER_BPS

const STAKING_ABI = [
  "function userStakedBalance(address account) view returns (uint256)",
  "function lockMultiplierBps(address account) view returns (uint256)",
];

/**
 * Pure computation, no network access. Inputs are the raw values InayaStaking
 * itself already exposes via its public mapping getters.
 * @param {{ stakedBalance: bigint, lockMultiplierBps: bigint }} params
 * @returns {bigint} vote weight, same 18-decimal scale as $INAYA
 */
function computeVoteWeight({ stakedBalance, lockMultiplierBps }) {
  const staked = BigInt(stakedBalance);
  if (staked === 0n) return 0n;
  const multiplier = BigInt(lockMultiplierBps) === 0n ? FLEXIBLE_MULTIPLIER_BPS : BigInt(lockMultiplierBps);
  return (staked * multiplier) / BPS_DENOMINATOR;
}

/**
 * Reads InayaStaking on-chain for one wallet and returns its current vote weight.
 * @param {import("ethers").Provider} provider
 * @param {string} stakingAddress
 * @param {string} walletAddress
 * @returns {Promise<bigint>}
 */
async function getVoteWeight(provider, stakingAddress, walletAddress) {
  const { Contract } = await import("ethers");
  const staking = new Contract(stakingAddress, STAKING_ABI, provider);
  const [stakedBalance, lockMultiplierBps] = await Promise.all([
    staking.userStakedBalance(walletAddress),
    staking.lockMultiplierBps(walletAddress),
  ]);
  return computeVoteWeight({ stakedBalance, lockMultiplierBps });
}

/**
 * Batched version for a known list of wallets (e.g. everyone who has ever
 * staked, gathered from Staked events) -- avoids one round trip per wallet
 * by running the reads concurrently.
 * @param {import("ethers").Provider} provider
 * @param {string} stakingAddress
 * @param {string[]} walletAddresses
 * @returns {Promise<Record<string, bigint>>}
 */
async function getVoteWeights(provider, stakingAddress, walletAddresses) {
  const { Contract } = await import("ethers");
  const staking = new Contract(stakingAddress, STAKING_ABI, provider);
  const entries = await Promise.all(
    walletAddresses.map(async (address) => {
      const [stakedBalance, lockMultiplierBps] = await Promise.all([
        staking.userStakedBalance(address),
        staking.lockMultiplierBps(address),
      ]);
      return [address, computeVoteWeight({ stakedBalance, lockMultiplierBps })];
    })
  );
  return Object.fromEntries(entries);
}

export { computeVoteWeight, getVoteWeight, getVoteWeights, FLEXIBLE_MULTIPLIER_BPS, BPS_DENOMINATOR };
