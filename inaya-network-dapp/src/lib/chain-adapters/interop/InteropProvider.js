// src/lib/chain-adapters/interop/InteropProvider.js
//
// Provider-neutral interoperability interface (Interop SOW, Phase 2).
// Sits ALONGSIDE the existing ChainAdapter/CrossChainTransport
// (../ChainAdapter.js, ../CrossChainTransport.js) rather than replacing
// them -- Inaya's own bridge keeps using CrossChainTransport/
// InayaMessengerTransport unchanged. This interface exists so Inaya's
// business logic can reach chains through a THIRD-PARTY interoperability
// network (Wormhole today, potentially others later) without that
// business logic being written against one vendor's SDK shape directly.
//
// Per docs/interoperability-provider-evaluation.md, Wormhole (NTT primary,
// WTT fallback) is the first real implementation (WormholeProvider.js).
// LayerZero is evaluated and deferred, not rejected -- LayerZeroProvider.js
// exists as a declared-but-unimplemented class, same pattern this
// codebase already uses for MOVE/OTHER chain families in registry.js:
// never claim a capability that hasn't been built.

/** @typedef {{ transferId: string, sourceTxHash: string, messageId: string|null }} InteropSendResult */
/** @typedef {"PENDING"|"PROCESSING"|"ATTESTING"|"RELAYING"|"COMPLETED"|"FAILED"} InteropTransferStatus */
/** @typedef {{ status: InteropTransferStatus, sourceTxHash: string, destTxHash: string|null, messageId: string|null, failureReason: string|null, timestamps: object }} InteropTransferRecord */

export class InteropProvider {
  /** @param {string} name */
  constructor(name) {
    if (new.target === InteropProvider) {
      throw new Error("InteropProvider is abstract — use a concrete provider (e.g. WormholeProvider).");
    }
    this.name = name;
  }

  /** @returns {Promise<Array<{ chainId: number, family: string, mode: string }>>}
   *  The chains THIS provider currently has real, live infrastructure on — not
   *  the provider's marketing chain-count, an actually-queried/documented list. */
  async getSupportedChains() {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<{ available: boolean, mode: string|null, reason: string|null }>}
   *  Whether a route between two chains is actually usable right now (contracts
   *  deployed + peers registered), not just "both chains are in the provider's
   *  general network." */
  async getRoute(_sourceChainId, _destChainId) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<{ estimatedFee: bigint, feeToken: string, breakdown: object }>} */
  async estimateFee(_params) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<InteropSendResult>} */
  async sendTransfer(_params) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<InteropTransferRecord>} */
  async getTransferStatus(_transferId) {
    throw new Error("Not implemented");
  }
}
