// src/lib/chain-adapters/EVMAdapter.js
//
// Wraps the exact ethers.js call shapes already used across
// api/bridge/**, page.js's ensureCorrectNetwork, and chains.js's own
// ensureChain() — no new on-chain logic, only a consistent interface
// over what already works for BSC/Sepolia/Fuji/(any future EVM chain).

import { ethers } from "ethers";
import { ChainAdapter } from "./ChainAdapter.js";

// Same conservative default this codebase already uses elsewhere for
// "how many blocks until we consider a testnet EVM tx final" — no
// existing finality logic to copy (confirmed by the audit), so this is a
// deliberately simple, documented starting point: enough to survive a
// typical shallow testnet reorg without being so high it stalls
// legitimate transfers. Revisit per-chain once real reorg data exists.
const DEFAULT_REQUIRED_CONFIRMATIONS = 3;

// Same reasoning as the AI routes' withCallTimeout (src/app/api/ai/business-chat/
// route.js): an RPC call can hang far longer than expected before ever failing
// (DNS resolution retry loops observed directly in this environment), so a health
// check needs its own hard timeout rather than trusting the underlying library to
// fail fast.
const HEALTH_CHECK_TIMEOUT_MS = 8_000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

export class EVMAdapter extends ChainAdapter {
  #provider;

  constructor(chainConfig, { useServerRpc = false } = {}) {
    super(chainConfig);
    const rpcUrl = useServerRpc ? chainConfig.serverRpcUrl : chainConfig.rpcUrl;
    const numericChainId = parseInt(chainConfig.hexChainId, 16);
    // staticNetwork skips ethers' own network auto-detection handshake --
    // without it, an unreachable/wrong RPC makes the provider retry
    // "detect network" forever in the background (observed directly: a
    // Promise.race timeout around a call still left the process hung,
    // because the underlying retry loop was never actually cancelled,
    // only stopped being awaited). We already know the chain ID from the
    // registry, so there's nothing to detect.
    this.#provider = new ethers.JsonRpcProvider(rpcUrl, numericChainId, { staticNetwork: true });
  }

  get provider() {
    return this.#provider;
  }

  async getNativeBalance(address) {
    return this.#provider.getBalance(address);
  }

  validateAddress(address) {
    return ethers.isAddress(address);
  }

  async getFinalityStatus(txHash) {
    const receipt = await this.#provider.getTransactionReceipt(txHash);
    if (!receipt) return { finalized: false, confirmations: 0, required: DEFAULT_REQUIRED_CONFIRMATIONS };
    const currentBlock = await this.#provider.getBlockNumber();
    const confirmations = Math.max(0, currentBlock - receipt.blockNumber + 1);
    return {
      finalized: confirmations >= DEFAULT_REQUIRED_CONFIRMATIONS,
      confirmations,
      required: DEFAULT_REQUIRED_CONFIRMATIONS,
    };
  }

  getExplorerUrl(txHash) {
    return `${this.chainConfig.blockExplorerUrl}/tx/${txHash}`;
  }

  async healthCheck() {
    const start = Date.now();
    try {
      const blockHeight = await withTimeout(this.#provider.getBlockNumber(), HEALTH_CHECK_TIMEOUT_MS);
      return { healthy: true, blockHeight, latencyMs: Date.now() - start, error: null };
    } catch (err) {
      return { healthy: false, blockHeight: null, latencyMs: Date.now() - start, error: err.message };
    }
  }

  // estimateTransfer/initiateTransfer/getTransferStatus intentionally NOT
  // implemented here yet — per the plan, Phase 3 moves these in as direct
  // wraps of the exact call sites already in api/bridge/** and
  // bridge/page.js, one at a time, verified against the existing test
  // suite at each step. Adding them now, unverified, would be exactly
  // the kind of unreviewed batch change this plan is designed to avoid.
}
