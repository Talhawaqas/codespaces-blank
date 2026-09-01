// src/lib/chain-adapters/CrossChainTransport.js
//
// Transport abstraction, per the plan. Exactly ONE implementation exists
// (InayaMessengerTransport, below) — it wraps the existing InayaMessenger
// sendMessage/executeMessage contract calls and the existing relayer flow
// (api/bridge/cron/relay-messages/route.js's validator-signature
// collection), unchanged. No external provider (LayerZero, Wormhole) is
// integrated — the interface exists so a future one COULD be added
// without touching adapter code, not because one is being added now.

export class CrossChainTransport {
  constructor(name) {
    if (new.target === CrossChainTransport) {
      throw new Error("CrossChainTransport is abstract.");
    }
    this.name = name;
  }

  /** @returns {Promise<{ messageId: string, txHash: string }>} */
  async sendMessage(_params) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<{ delivered: boolean, txHash: string|null }>} */
  async receiveMessage(_messageId) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<boolean>} */
  async verifyMessage(_messageId) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<"pending"|"verifying"|"relaying"|"completed"|"failed">} */
  async getMessageStatus(_messageId) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<{ estimatedFee: bigint, feeToken: string }>} */
  async estimateFee(_params) {
    throw new Error("Not implemented");
  }

  /** @returns {Promise<{ retried: boolean }>} */
  async retryMessage(_messageId) {
    throw new Error("Not implemented");
  }
}

/** The one real transport: Inaya's own InayaMessenger contracts + the
 *  existing cron-driven relayer. Every method below is a thin wrapper —
 *  see the cited existing code for the actual logic, which stays exactly
 *  as it is. Not yet wired into any live route (Phase 3 of the plan);
 *  this class exists now so the interface has a real implementation to
 *  validate against, per "design the interface against something real,
 *  not a hypothetical." */
export class InayaMessengerTransport extends CrossChainTransport {
  constructor() {
    super("inaya-messenger");
  }

  // sendMessage()      -> wraps InayaMessenger.sol's sendMessage() / InayaTokenBridgeHome/Spoke's bridgeOut/bridgeToHome
  // receiveMessage()   -> wraps InayaMessenger.sol's executeMessage(), called by the relayer cron
  // verifyMessage()    -> wraps InayaValidatorSet.sol's verifyThreshold() read path
  // getMessageStatus() -> wraps GET /api/bridge/transfer-status/[id]'s bridge_transfers lookup
  // estimateFee()      -> wraps the existing gas-estimation call sites in bridge/page.js
  // retryMessage()     -> wraps InayaMessenger.sol's existing "Failed status is retryable" design
  //
  // Left as documented pass-throughs rather than implemented here: each
  // one needs the exact existing call site identified and wrapped
  // in Phase 3, verified against the test suite at that point — writing
  // them now, unverified, would be the unreviewed-batch-change this plan
  // exists to avoid.
}
