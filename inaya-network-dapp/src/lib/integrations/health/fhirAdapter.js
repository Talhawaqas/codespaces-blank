// src/lib/integrations/health/fhirAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§10.25) — FHIR adapter
// interface. Real FHIR resource candidates per the SOW: Patient,
// Practitioner, Organization, Encounter, Observation, DiagnosticReport,
// MedicationRequest, AllergyIntolerance, Condition, CarePlan,
// DocumentReference, Appointment, Consent. This adapter never fabricates
// external FHIR records — see adapterStub.js's header.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getFhirAdapter() {
  return getConfiguredAdapter({
    name: "FHIR",
    methods: ["getPatient", "getPractitioner", "getEncounter", "getObservation", "getDiagnosticReport", "getMedicationRequest", "getAllergyIntolerance", "getCondition", "getCarePlan", "getDocumentReference", "getAppointment", "getConsent"],
    checkEnv: ["FHIR_BASE_URL", "FHIR_CLIENT_ID", "FHIR_CLIENT_SECRET"],
  });
}
