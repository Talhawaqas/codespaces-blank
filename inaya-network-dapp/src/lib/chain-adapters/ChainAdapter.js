// src/lib/chain-adapters/ChainAdapter.js
//
// Universal Chain Adapter interface. Every method here wraps a call path
// that already exists and already works elsewhere in this codebase — see
// each method's comment for exactly what it wraps. This file defines the
// shape only; EVMAdapter.js and SolanaAdapter.js are the real
// implementations. Not wired into any live route yet (see docs/
// chain-agnostic-audit.md's Phase 3 for that step) — this phase is purely
// additive, so it cannot regress anything currently working.
//
// Adapted from the spec's suggested method list, not copied blindly:
// getFinalityStatus() is new logic (no chain-specific finality check
// exists anywhere in this codebase today, confirmed by the audit) rather
// than a wrapper — every other method wraps something real.

/** @typedef {{ finalized: boolean, confirmations: number, required: number }} FinalityStatus */

export class ChainAdapter {
  /** @param {object} chainConfig - the chains.js CHAINS[chainId] entry (or SOLANA_META) this adapter wraps. */
  constructor(chainConfig) {
    if (new.target === ChainAdapter) {
      throw new Error("ChainAdapter is abstract — use EVMAdapter or SolanaAdapter.");
    }
    this.chainConfig = chainConfig;
  }

  /** The chains.js entry itself, unchanged shape — no transformation. */
  getChainInfo() {
    return this.chainConfig;
  }

  /** @param {string} address @returns {Promise<bigint>} native token balance, smallest unit. */
  async getNativeBalance(_address) {
    throw new Error("Not implemented");
  }

  /** @param {string} address @returns {boolean} */
  validateAddress(_address) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<{ estimatedFee: bigint, feeToken: string }>} */
  async estimateTransfer(_params) {
    throw new Error("Not implemented");
  }

  /** Wraps the real, existing bridgeOut/bridgeToHome contract call — never reimplements it. */
  async initiateTransfer(_params) {
    throw new Error("Not implemented");
  }

  /** Wraps GET /api/bridge/transfer-status/[id] — same messageHash-keyed lookup every UI already uses. */
  async getTransferStatus(_transferId) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<FinalityStatus>} Real per-chain finality — the one genuinely new capability
   *  this abstraction adds (see docs/chain-agnostic-audit.md gap #4). Not yet enforced as a hard
   *  gate anywhere; wired into index-events as a soft, logged-only check first (Phase 3). */
  async getFinalityStatus(_txHash) {
    throw new Error("Not implemented");
  }

  /** @returns {string} block explorer URL for a tx hash — wraps chains.js's blockExplorerUrl. */
  getExplorerUrl(_txHash) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<{ healthy: boolean, blockHeight: number|null, latencyMs: number, error: string|null }>}
   *  Same read-only RPC-reachability check scripts/testnet-health-check.js already proved out —
   *  this wraps that same pattern per-adapter instead of the standalone script. */
  async healthCheck() {
    throw new Error("Not implemented");
  }
}
