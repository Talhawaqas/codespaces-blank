// src/lib/integrations/legal/efilingAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§12) — court e-filing
// adapter interface. This adapter never files anything itself — no code
// path in legal-hold-workflow.js, legal-discovery, or any AI tool calls
// this to actually submit a filing; ai-legal-tools.js's own guardrail
// explicitly refuses filing requests. This is a reference interface for
// a future real integration, not a live filing capability.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getEfilingAdapter() {
  return getConfiguredAdapter({
    name: "Court E-Filing",
    methods: ["submitFiling", "getFilingStatus", "getCourtDocket"],
    checkEnv: ["EFILING_PROVIDER_URL", "EFILING_API_KEY"],
  });
}
