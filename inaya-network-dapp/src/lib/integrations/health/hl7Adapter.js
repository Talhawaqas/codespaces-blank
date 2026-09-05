// src/lib/integrations/health/hl7Adapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§10.25) — HL7 v2 message
// adapter interface (ADT/ORU/ORM-style feeds from an EHR/HIS). See
// adapterStub.js's header for why this is a documented interface + a
// stub, not a live integration.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getHl7Adapter() {
  return getConfiguredAdapter({
    name: "HL7",
    methods: ["parseAdtMessage", "parseOruMessage", "parseOrmMessage", "sendAcknowledgement"],
    checkEnv: ["HL7_INBOUND_ENDPOINT", "HL7_FACILITY_ID"],
  });
}
