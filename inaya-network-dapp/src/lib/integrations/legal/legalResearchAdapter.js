// src/lib/integrations/legal/legalResearchAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§11.19, §12) — legal
// research provider adapter (Westlaw/Lexis-style). ai-legal-tools.js
// never fabricates a case citation or statute itself; a real
// implementation of this adapter is what would let search results be
// tagged sourceType:"retrieved" with a real citation rather than
// sourceType:"generated".

import { getConfiguredAdapter } from "../adapterStub.js";

export function getLegalResearchAdapter() {
  return getConfiguredAdapter({
    name: "Legal Research",
    methods: ["searchCaseLaw", "searchStatutes", "getCitation"],
    checkEnv: ["LEGAL_RESEARCH_PROVIDER_URL", "LEGAL_RESEARCH_API_KEY"],
  });
}
