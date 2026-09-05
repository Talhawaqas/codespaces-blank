// src/lib/integrations/legal/esignatureAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§11.26, §12) — e-signature
// adapter interface for contract-lifecycle-workflow.js's "sign" step.
// The `sign` transition itself is still a real, internally-tracked state
// change (contract-lifecycle-workflow.js:CONTRACT_TRANSITIONS.sign) —
// this adapter is only what a real integration would use to actually
// collect a signature from the counterparty before that transition is
// called, not a replacement for the state machine.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getEsignatureAdapter() {
  return getConfiguredAdapter({
    name: "E-Signature",
    methods: ["createSignatureRequest", "getSignatureStatus", "getSignedDocument"],
    checkEnv: ["ESIGNATURE_PROVIDER_URL", "ESIGNATURE_API_KEY"],
  });
}
