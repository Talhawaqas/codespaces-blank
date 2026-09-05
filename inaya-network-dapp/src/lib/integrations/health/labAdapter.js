// src/lib/integrations/health/labAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§10.14, §10.25) — laboratory
// (LIS) reference adapter. SOW §10.14 is explicit: "Do not replace an LIS
// without a separate integration" — this only references external
// test/order/result/specimen records by ID, never stores raw lab data.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getLabAdapter() {
  return getConfiguredAdapter({
    name: "Laboratory (LIS)",
    methods: ["getOrder", "getResult", "getSpecimenStatus"],
    checkEnv: ["LIS_BASE_URL", "LIS_API_KEY"],
  });
}
