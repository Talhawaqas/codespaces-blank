// GET /api/bridge/staking-position/[address]
//
// Public. Live read against the canonical home-chain InayaStaking (v2) contract, plus the
// per-origin-chain breakdown (userStakedByChain -- a lifetime-inflow counter, see
// contracts/InayaStaking.sol's doc comment: analytics only, not a live per-chain balance).

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { CHAINS, CHAIN_IDS, SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains";

const STAKING_ABI = [
  "function userStakedBalance(address) view returns (uint256)",
  "function rewards(address) view returns (uint256)",
  "function earned(address) view returns (uint256)",
  "function lockExpiry(address) view returns (uint256)",
  "function lockMultiplierBps(address) view returns (uint256)",
  "function userStakedByChain(address, uint256) view returns (uint256)",
];

const BREAKDOWN_CHAIN_IDS = [CHAIN_IDS.BSC_TESTNET, CHAIN_IDS.SEPOLIA, CHAIN_IDS.AMOY, CHAIN_IDS.FUJI, SOLANA_DEVNET_CHAIN_ID];

export async function GET(request, { params }) {
  const { address } = params;
  if (!ethers.isAddress(address)) {
    return NextResponse.json({ success: false, error: "Invalid address" }, { status: 400 });
  }

  const home = CHAINS[CHAIN_IDS.BSC_TESTNET];
  if (!home.contracts.staking) {
    return NextResponse.json({ success: false, error: "Staking contract not configured" }, { status: 500 });
  }

  const provider = new ethers.JsonRpcProvider(home.serverRpcUrl);
  const staking = new ethers.Contract(home.contracts.staking, STAKING_ABI, provider);

  const [userStakedBalance, rewards, earned, lockExpiry, lockMultiplierBps, ...byChain] = await Promise.all([
    staking.userStakedBalance(address),
    staking.rewards(address),
    staking.earned(address),
    staking.lockExpiry(address),
    staking.lockMultiplierBps(address),
    ...BREAKDOWN_CHAIN_IDS.map((chainId) => staking.userStakedByChain(address, chainId)),
  ]);

  return NextResponse.json({
    success: true,
    position: {
      userStakedBalance: userStakedBalance.toString(),
      rewards: rewards.toString(),
      earned: earned.toString(),
      lockExpiry: lockExpiry.toString(),
      lockMultiplierBps: lockMultiplierBps.toString(),
      byOriginChain: BREAKDOWN_CHAIN_IDS.map((chainId, i) => ({ chainId, lifetimeStaked: byChain[i].toString() })),
    },
  });
}
