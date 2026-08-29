// GET /api/bridge/supported-chains
//
// Public. Returns the chain config list from src/lib/chains.js -- safe to expose in full, every
// field here is already client-readable (NEXT_PUBLIC_*).

import { NextResponse } from "next/server";
import { listSupportedChains, SOLANA_META, SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains";

export async function GET() {
  const chains = listSupportedChains();
  return NextResponse.json({
    success: true,
    chains: [...chains, { chainId: SOLANA_DEVNET_CHAIN_ID, ...SOLANA_META }],
  });
}
