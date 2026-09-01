// GET /api/interop/supported-chains
//
// Public. Interop SOW Phase 6's data foundation -- the frontend's future chain picker for
// interop-layer routes should read from here, not hardcode a chain list. Two parts:
// `providerReach` is a REAL, live query against Wormhole's own SDK (WormholeProvider.
// getSupportedChains() -- see src/lib/chain-adapters/interop/WormholeProvider.js) confirming
// which chains Wormhole's core infrastructure actually reaches on testnet. `capability` is
// Inaya's own honest classification (src/lib/chain-adapters/interop/capabilityRegistry.js) of
// how much of THAT reach Inaya has actually turned into something usable -- as of this
// writing, every chain is Tier C / ROUTE_AVAILABLE, meaning provider reach is confirmed but
// Inaya hasn't deployed anything yet. Never merge these into one "supported: true" boolean --
// that's exactly the overclaiming Phase 12 exists to prevent.

import { NextResponse } from "next/server";
import { getInteropProvider, listInteropCapabilities } from "@/lib/chain-adapters/interop";

export async function GET() {
  const provider = getInteropProvider();
  const [providerReach, capability] = await Promise.all([
    provider.getSupportedChains(),
    Promise.resolve(listInteropCapabilities()),
  ]);
  return NextResponse.json({ success: true, provider: provider.name, providerReach, capability });
}
