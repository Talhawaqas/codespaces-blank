// src/lib/integrations/health/claimsAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§10.16, §10.25) — insurance
// claims/EDI reference adapter. SOW §10.16 is explicit: "Claims/EDI
// should be integration-based" — health-billing.js's own invoices never
// submit or adjudicate a claim, they only reference claimsStatus fetched
// through this adapter.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getClaimsAdapter() {
  return getConfiguredAdapter({
    name: "Claims/EDI",
    methods: ["submitClaim", "getClaimStatus", "getEligibility"],
    checkEnv: ["CLAIMS_CLEARINGHOUSE_URL", "CLAIMS_API_KEY"],
  });
}
