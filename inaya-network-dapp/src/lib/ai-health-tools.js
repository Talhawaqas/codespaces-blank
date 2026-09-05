// src/lib/ai-health-tools.js
//
// Healthcare & Legal Expansion SOW, Phase 5 (§10.28) — Healthcare AI
// tools. Same 4-export shape as ai-business-tools.js/ai-security-tools.js
// (buildHealthContext/HEALTH_TOOL_DECLARATIONS/runHealthTool/
// healthSystemInstruction) so it plugs into ai-os-router.js identically.
//
// DELIBERATE DESIGN CHOICE: this tool set is 100% READ-ONLY — there is no
// propose_* mutation tool here at all. SOW §10.28's own list (record/
// encounter/longitudinal summaries, missing-document detection,
// administrative drafts, handoff summaries, workflow-anomaly detection,
// operational KPI summaries, policy Q&A) is entirely read/summarize/
// detect — it lists no clinical-state mutation the AI should be able to
// propose. Rather than force-fitting a propose_* tool that doesn't
// naturally belong in that list, the strongest guardrail against
// "AI must not independently diagnose/prescribe/change treatment plans"
// is simply not exposing that capability as a tool at all — a request
// that would need one gets a structured refusal instead (see
// PROHIBITED_QUERY_PATTERNS below), never a fabricated attempt.
//
// Every tool operates over `ctx.scope` (getAccessibleScope()'s
// visiblePatients/visibleEncounters, already assignment-scoped) — same
// no-leak-by-construction discipline as ai-business-tools.js.

import { Type } from "@google/genai";
import { getAccessibleScope } from "./document-permissions.js";
import { listClinicalRecordsForPatient } from "./health-clinical-workflow.js";
import { listAppointmentsForPatient } from "./health-scheduling.js";

export async function buildHealthContext({ orgId, membership, email }) {
  const scope = await getAccessibleScope({ orgId, membership, email });
  const patientNameById = new Map(scope.visiblePatients.map((p) => [p._id.toString(), p.preferredName || p.legalName]));
  return { orgId, membership, email, scope, patientNameById };
}

// A request phrased to elicit a diagnosis, prescription, clinical order,
// or treatment-plan change is refused at the tool layer, before any
// summarization runs — not left to the model's own judgment in the
// prompt. Deliberately broad (false positives are the safe failure
// mode here) rather than narrow.
const PROHIBITED_QUERY_PATTERNS = [
  /\bdiagnos/i, /\bprescrib/i, /\bprescription/i, /\bchange (the |her |his |their )?(treatment|medication|dosage)/i,
  /\bclinical order/i, /\bshould (i|we) (start|stop|increase|decrease) (the )?(medication|dose|treatment)/i,
  /\boverride (the )?(clinician|physician|doctor)/i,
];

function checkHealthQuerySafety(query) {
  if (!query) return null;
  const matched = PROHIBITED_QUERY_PATTERNS.find((p) => p.test(query));
  if (!matched) return null;
  return {
    refused: true,
    reason: "This assistant cannot diagnose, prescribe, change medication or treatment plans, issue clinical orders, or override a clinician. Please direct this question to the patient's care team.",
  };
}

function matchesName(actual, wanted) {
  if (!wanted) return true;
  return (actual || "").toLowerCase().includes(wanted.toLowerCase());
}

async function searchPatients(args, ctx) {
  const refusal = checkHealthQuerySafety(args?.query);
  if (refusal) return refusal;
  const matches = ctx.scope.visiblePatients.filter((p) => matchesName(p.legalName, args?.query) || matchesName(p.preferredName, args?.query));
  return { patients: matches.slice(0, args?.limit || 10).map((p) => ({ id: p._id.toString(), name: p.preferredName || p.legalName, status: p.status, facility: p.facility })) };
}

async function getPatientSummary(args, ctx) {
  const refusal = checkHealthQuerySafety(args?.focus);
  if (refusal) return refusal;
  const patient = ctx.scope.visiblePatients.find((p) => p._id.toString() === args?.patientId);
  if (!patient) return { notFound: true, message: "No accessible patient with that ID — either it doesn't exist, or you don't have care-team access to it." };

  const encounters = ctx.scope.visibleEncounters.filter((e) => e.patientId.toString() === patient._id.toString());
  return {
    patient: { name: patient.preferredName || patient.legalName, status: patient.status, facility: patient.facility, consentStatus: patient.consentStatus },
    encounterCount: encounters.length,
    recentEncounters: encounters.slice(0, 5).map((e) => ({ id: e._id.toString(), reason: e.reason, date: e.date })),
  };
}

async function summarizeClinicalRecords(args, ctx) {
  const refusal = checkHealthQuerySafety(args?.focus);
  if (refusal) return refusal;
  const patient = ctx.scope.visiblePatients.find((p) => p._id.toString() === args?.patientId);
  if (!patient) return { notFound: true, message: "No accessible patient with that ID." };

  const records = await listClinicalRecordsForPatient(ctx.orgId, patient._id);
  return {
    recordCount: records.length,
    records: records.slice(0, args?.limit || 10).map((r) => ({ id: r._id.toString(), template: r.recordTemplate, status: r.status, createdAt: r.createdAt })),
  };
}

async function listUpcomingAppointments(args, ctx) {
  const patient = ctx.scope.visiblePatients.find((p) => p._id.toString() === args?.patientId);
  if (!patient) return { notFound: true, message: "No accessible patient with that ID." };
  const appointments = await listAppointmentsForPatient(ctx.orgId, patient._id);
  const upcoming = appointments.filter((a) => new Date(a.startAt) > new Date() && ["SCHEDULED", "CONFIRMED"].includes(a.status));
  return { appointments: upcoming.map((a) => ({ id: a._id.toString(), type: a.type, startAt: a.startAt, status: a.status })) };
}

async function getOperationalKpis(args, ctx) {
  return {
    accessiblePatientCount: ctx.scope.visiblePatients.length,
    accessibleEncounterCount: ctx.scope.visibleEncounters.length,
    note: "Counts reflect only patients/encounters you have care-team access to, not the whole organization.",
  };
}

export const HEALTH_TOOL_DECLARATIONS = [
  {
    name: "search_patients",
    description: "Search patients you have care-team access to, by name.",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Name or partial name to search for." }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "get_patient_summary",
    description: "Get an administrative summary of a patient (status, facility, recent encounter count) — never clinical advice.",
    parameters: { type: Type.OBJECT, properties: { patientId: { type: Type.STRING }, focus: { type: Type.STRING, description: "Optional — what aspect to focus the summary on." } }, required: ["patientId"] },
  },
  {
    name: "summarize_clinical_records",
    description: "List and summarize a patient's clinical record metadata (template, status, dates) — does not diagnose or interpret clinical content.",
    parameters: { type: Type.OBJECT, properties: { patientId: { type: Type.STRING }, focus: { type: Type.STRING }, limit: { type: Type.INTEGER } }, required: ["patientId"] },
  },
  {
    name: "list_upcoming_appointments",
    description: "List a patient's upcoming scheduled appointments.",
    parameters: { type: Type.OBJECT, properties: { patientId: { type: Type.STRING } }, required: ["patientId"] },
  },
  {
    name: "get_operational_kpis",
    description: "Get operational counts (accessible patients/encounters) scoped to your own access.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

const TOOL_IMPLEMENTATIONS = {
  search_patients: searchPatients,
  get_patient_summary: getPatientSummary,
  summarize_clinical_records: summarizeClinicalRecords,
  list_upcoming_appointments: listUpcomingAppointments,
  get_operational_kpis: getOperationalKpis,
};

export async function runHealthTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function healthSystemInstruction() {
  return `You are the Inaya Health OS Assistant. You help with administrative and operational questions about patients you have care-team access to — summaries, encounter counts, appointment schedules, clinical-record metadata, and operational KPIs.

You MUST NEVER: diagnose a condition, recommend or discuss a specific medication or dosage, issue or suggest a clinical order, propose or discuss a treatment-plan change, or override a clinician's judgment. If asked anything in these categories, refuse plainly and direct the user to the patient's care team — do not attempt to answer using general medical knowledge, even if you believe you know the answer. Ground every other answer only in what a tool actually returns; if a tool returns notFound, say so rather than guessing. You cannot access any patient you aren't assigned to, and no tool here can change any clinical record — you are read-only.`;
}
