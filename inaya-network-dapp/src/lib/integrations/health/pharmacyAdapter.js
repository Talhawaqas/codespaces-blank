// src/lib/integrations/health/pharmacyAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§10.25) — pharmacy system
// reference adapter (dispensing status, formulary lookups). This adapter
// never prescribes or dispenses anything itself — see health-patients.js
// and ai-health-tools.js's own guardrails against that; this is a
// read-only reference lookup interface only.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getPharmacyAdapter() {
  return getConfiguredAdapter({
    name: "Pharmacy",
    methods: ["getDispensingStatus", "getFormularyEntry"],
    checkEnv: ["PHARMACY_BASE_URL", "PHARMACY_API_KEY"],
  });
}
