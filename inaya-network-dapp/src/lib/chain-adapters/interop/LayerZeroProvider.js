// src/lib/chain-adapters/interop/LayerZeroProvider.js
//
// LayerZero was evaluated (docs/interoperability-provider-evaluation.md)
// and deferred, not rejected -- its DVN model would let Inaya's own
// validator set (contracts/bridge/InayaValidatorSet.sol) participate
// directly in cross-chain message security as a required DVN, which
// neither Wormhole product offers. That's a genuinely compelling future
// direction, but realizing it means running new off-chain DVN node
// infrastructure, which is out of scope for this SOW's explicit
// "minimum Inaya-side deployment overhead" objective.
//
// Declared as a class only, zero implementation -- same pattern this
// codebase already uses for MOVE/OTHER chain families in ../registry.js:
// never claim a capability that hasn't been built. Existing here purely
// so the provider-neutral InteropProvider interface has a second, real
// example to validate against (a single-implementation interface isn't
// proven to actually be provider-neutral).

import { InteropProvider } from "./InteropProvider.js";

export class LayerZeroProvider extends InteropProvider {
  constructor() {
    super("layerzero");
  }
  // No methods implemented. See docs/interoperability-provider-evaluation.md
  // for what a real implementation would need: OFT (or OFT Adapter) deployed
  // per destination chain, a DVN security-stack configuration decision
  // (start with LayerZero's own default DVNs; Inaya-run DVN is the future
  // enhancement this class exists to leave room for), and Executor wiring.
}
