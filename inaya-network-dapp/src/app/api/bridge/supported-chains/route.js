// GET /api/bridge/supported-chains
//
// Public. Returns the chain config list from src/lib/chains.js -- safe to expose in full, every
// field here is already client-readable (NEXT_PUBLIC_*).

import { NextResponse } from "next/server";
import { listSupportedChains, SOLANA_META, SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains";

export async function GET() {
  // Only offer chains whose bridge contracts are configured in this environment. The relayer and
  // indexer crons skip any chain without a messenger address, so a transfer to an unconfigured
  // chain locks the user's $INAYA on the home chain and is never delivered.
  const chains = listSupportedChains().filter((c) => c.isHome || (c.contracts?.messenger && c.contracts?.bridge));
  return NextResponse.json({
    success: true,
    chains: [...chains, { chainId: SOLANA_DEVNET_CHAIN_ID, ...SOLANA_META }],
  });
}
