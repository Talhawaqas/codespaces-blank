// snapshot-strategy/inaya-stake-weight/index.js
//
// Governance Charter Phase 1: a custom Snapshot strategy scoring each voter
// by real InayaStaking stake x lock-tier multiplier, matching
// src/lib/voteWeight.js's computeVoteWeight() exactly (that file is the
// source of truth for the formula; this reimplements it in Snapshot's
// required strategy interface, which cannot import from the Next.js app).
//
// This file follows the exact interface every strategy in the official
// @snapshot-labs/snapshot-strategies monorepo implements. It is NOT
// automatically "live" just by existing here -- Snapshot spaces only load
// strategies from that published package (or from a self-hosted score-api
// pointed at a custom strategy list). To actually use this in a real Inaya
// Snapshot space, either:
//   1. Submit it as a PR to snapshot-labs/snapshot-strategies (the standard
//      path -- other spaces could reuse it too once merged), or
//   2. Self-host a score-api instance with this strategy registered locally
//      (faster to stand up, but Inaya then owns running that service).
// See ../README.md for the concrete next steps either way.

import { multicall } from './multicall.js';

export const author = 'inaya-network';
export const version = '0.1.0';

const STAKING_ABI = [
  'function userStakedBalance(address account) view returns (uint256)',
  'function lockMultiplierBps(address account) view returns (uint256)',
];

const BPS_DENOMINATOR = 10000n;
const FLEXIBLE_MULTIPLIER_BPS = 10000n; // matches InayaStaking.FLEXIBLE_MULTIPLIER_BPS

export async function strategy(
  space,
  network,
  provider,
  addresses,
  options,
  snapshot
) {
  const blockTag = typeof snapshot === 'number' ? snapshot : 'latest';
  const stakingAddress = options.stakingAddress;
  if (!stakingAddress) {
    throw new Error('inaya-stake-weight: options.stakingAddress is required (InayaStaking contract address)');
  }

  // Two multicalls (one per view function) rather than N individual eth_calls
  // per voter -- Snapshot spaces routinely score thousands of addresses, and
  // per-address RPC calls would either time out or get rate-limited. This
  // mirrors how every real strategy in snapshot-strategies batches reads.
  const stakedBalanceCalls = addresses.map((address) => [
    stakingAddress,
    'userStakedBalance',
    [address],
  ]);
  const lockMultiplierCalls = addresses.map((address) => [
    stakingAddress,
    'lockMultiplierBps',
    [address],
  ]);

  const [stakedBalances, lockMultipliers] = await Promise.all([
    multicall(network, provider, STAKING_ABI, stakedBalanceCalls, { blockTag }),
    multicall(network, provider, STAKING_ABI, lockMultiplierCalls, { blockTag }),
  ]);

  const scores = {};
  addresses.forEach((address, i) => {
    const staked = BigInt(stakedBalances[i][0].toString());
    if (staked === 0n) {
      scores[address] = 0;
      return;
    }
    const rawMultiplier = BigInt(lockMultipliers[i][0].toString());
    const multiplier = rawMultiplier === 0n ? FLEXIBLE_MULTIPLIER_BPS : rawMultiplier;
    const weight = (staked * multiplier) / BPS_DENOMINATOR;
    // Snapshot strategy scores are plain JS numbers scaled to the token's
    // decimals (18 here, same convention as e.g. erc20-balance-of) -- this
    // loses BigInt precision above ~2^53 wei-equivalent, which is a real
    // Snapshot platform constraint, not something this strategy can opt out of.
    scores[address] = Number(weight) / 1e18;
  });

  return scores;
}
