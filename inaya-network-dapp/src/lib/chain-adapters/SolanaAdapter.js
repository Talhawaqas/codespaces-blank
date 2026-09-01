// src/lib/chain-adapters/SolanaAdapter.js
//
// Wraps @solana/web3.js the same way SolanaBridgePanel.jsx/
// SolanaWalletProviders.jsx already do for the /bridge page's Solana
// panel — no new on-chain logic. Solana's finality model is fundamentally
// different from EVM's block-confirmation-count model (per the plan's
// explicit instruction not to fake a shared model across chain
// families): Solana uses commitment levels (processed -> confirmed ->
// finalized), not a confirmation count, so getFinalityStatus() here
// reports that model's own terms rather than forcing EVM's shape onto it.

import { Connection, PublicKey } from "@solana/web3.js";
import { ChainAdapter } from "./ChainAdapter.js";

// Same reasoning as EVMAdapter.js's withTimeout -- an RPC call can hang far
// longer than expected before ever failing (observed directly in this
// environment as DNS resolution retry loops), so healthCheck needs its own
// hard timeout.
const HEALTH_CHECK_TIMEOUT_MS = 8_000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

export class SolanaAdapter extends ChainAdapter {
  #connection;

  constructor(chainConfig) {
    super(chainConfig);
    this.#connection = new Connection(chainConfig.cluster ? `https://api.${chainConfig.cluster}.solana.com` : "https://api.devnet.solana.com", "confirmed");
  }

  get connection() {
    return this.#connection;
  }

  async getNativeBalance(address) {
    return this.#connection.getBalance(new PublicKey(address));
  }

  validateAddress(address) {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /** Solana's actual finality model — commitment level, not a block-confirmation count.
   *  `finalized` here means the transaction reached Solana's own "finalized" commitment
   *  (irreversible, ~1 epoch/2 slots' worth of supermajority votes), not an EVM-style
   *  arbitrary confirmation-count threshold. */
  async getFinalityStatus(txHash) {
    const status = await this.#connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
    const confirmationStatus = status?.value?.confirmationStatus || null;
    return {
      finalized: confirmationStatus === "finalized",
      confirmations: status?.value?.confirmations ?? 0,
      required: null, // not a count-based model — `finalized` is the real answer for Solana
      commitmentStatus: confirmationStatus,
    };
  }

  getExplorerUrl(txHash) {
    const cluster = this.chainConfig.cluster && this.chainConfig.cluster !== "mainnet-beta" ? `?cluster=${this.chainConfig.cluster}` : "";
    return `https://explorer.solana.com/tx/${txHash}${cluster}`;
  }

  async healthCheck() {
    const start = Date.now();
    try {
      const blockHeight = await withTimeout(this.#connection.getSlot(), HEALTH_CHECK_TIMEOUT_MS);
      return { healthy: true, blockHeight, latencyMs: Date.now() - start, error: null };
    } catch (err) {
      return { healthy: false, blockHeight: null, latencyMs: Date.now() - start, error: err.message };
    }
  }

  // estimateTransfer/initiateTransfer/getTransferStatus deferred to
  // Phase 3, same reasoning as EVMAdapter.js — Solana's messaging path
  // isn't wired on-chain yet either (see the audit), so there is no
  // working call site to wrap for those methods yet.
}
