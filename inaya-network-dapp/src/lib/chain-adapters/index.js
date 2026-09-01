// src/lib/chain-adapters/index.js
//
// Adapter factory + barrel export. getAdapter(chainId) is the one entry
// point Phase 3's route migrations will call instead of constructing
// ethers.Contract/@solana/web3.js instances directly.

import { getChain, SOLANA_DEVNET_CHAIN_ID, SOLANA_META } from "../chains.js";
import { EVMAdapter } from "./EVMAdapter.js";
import { SolanaAdapter } from "./SolanaAdapter.js";

export { ChainAdapter } from "./ChainAdapter.js";
export { EVMAdapter } from "./EVMAdapter.js";
export { SolanaAdapter } from "./SolanaAdapter.js";
export { CrossChainTransport, InayaMessengerTransport } from "./CrossChainTransport.js";
export { SUPPORT_LEVELS, SUPPORT_LEVEL_LABELS, CHAIN_FAMILIES, getChainCapability, listChainCapabilities, isTransferReady } from "./registry.js";

/** @param {number} chainId @param {{ useServerRpc?: boolean }} [options]
 *  @returns {import("./ChainAdapter.js").ChainAdapter} */
export function getAdapter(chainId, options) {
  const numericId = Number(chainId);
  if (numericId === SOLANA_DEVNET_CHAIN_ID) {
    return new SolanaAdapter(SOLANA_META);
  }
  const chainConfig = getChain(numericId);
  if (!chainConfig) {
    throw new Error(`No adapter available for chainId ${numericId} — not in the chain registry.`);
  }
  return new EVMAdapter(chainConfig, options);
}
