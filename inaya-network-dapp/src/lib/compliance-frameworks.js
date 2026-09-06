// src/lib/compliance-frameworks.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§45) — the
// Regulatory Framework Engine's framework/requirement catalog. This is
// deliberately STATIC reference data, not a database table: frameworks
// like NIST CSF 2.0 or SOC 2 don't change per-organization, and treating
// them as editable rows would invite an org silently "customizing" a
// requirement's text away from its actual source. What IS org-specific is
// which frameworks an org has chosen to adopt — that one small fact lives
// in a single compliance_org_frameworks doc per org (mirrors
// industry-config.js's single-profile-doc pattern), never duplicated
// per-requirement.
//
// Per the SOW's own repeated instruction (§45, §283, §305): this catalog
// is a design/mapping reference, never a claim of certification. Every
// requirement's `description` is a short paraphrase for control-mapping
// purposes, not the authoritative regulatory text — REFERENCE_DISCLAIMER
// below must be surfaced wherever this catalog is rendered.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageCompliance } from "./orgGates.js";

export const REFERENCE_DISCLAIMER =
  "These framework and requirement mappings are design references for organizing controls and " +
  "evidence. They do not constitute legal advice, a compliance certification, or a guarantee of " +
  "regulatory compliance. Applicability must be determined by qualified legal/compliance " +
  "professionals for your specific organization and jurisdiction.";

export const FRAMEWORKS = {
  NIST_CSF_2: {
    id: "NIST_CSF_2",
    name: "NIST Cybersecurity Framework 2.0",
    version: "2.0",
    requirements: [
      { id: "GOVERN", title: "Govern", description: "Organizational context, risk management strategy, and cybersecurity governance are established and communicated." },
      { id: "IDENTIFY", title: "Identify", description: "Assets, risks, and vulnerabilities relevant to cybersecurity are understood." },
      { id: "PROTECT", title: "Protect", description: "Safeguards are implemented to manage cybersecurity risk to assets." },
      { id: "DETECT", title: "Detect", description: "Cybersecurity events are found and analyzed in a timely manner." },
      { id: "RESPOND", title: "Respond", description: "Actions are taken regarding a detected cybersecurity incident." },
      { id: "RECOVER", title: "Recover", description: "Assets and operations affected by a cybersecurity incident are restored." },
    ],
  },
  ISO_27001: {
    id: "ISO_27001",
    name: "ISO/IEC 27001",
    version: "2022",
    requirements: [
      { id: "A5", title: "Organizational controls", description: "Policies, roles, and responsibilities for information security are defined and assigned." },
      { id: "A6", title: "People controls", description: "Personnel screening, training, and disciplinary processes support information security." },
      { id: "A7", title: "Physical controls", description: "Physical access to facilities and equipment is controlled." },
      { id: "A8", title: "Technological controls", description: "Access control, cryptography, logging, and technical vulnerabilities are managed." },
    ],
  },
  SOC_2: {
    id: "SOC_2",
    name: "SOC 2 (Trust Services Criteria)",
    version: "2017 (with 2022 revisions)",
    requirements: [
      { id: "CC_SECURITY", title: "Security", description: "The system is protected against unauthorized access, both physical and logical." },
      { id: "CC_AVAILABILITY", title: "Availability", description: "The system is available for operation and use as committed or agreed." },
      { id: "CC_PROCESSING_INTEGRITY", title: "Processing Integrity", description: "System processing is complete, valid, accurate, timely, and authorized." },
      { id: "CC_CONFIDENTIALITY", title: "Confidentiality", description: "Information designated as confidential is protected as committed or agreed." },
      { id: "CC_PRIVACY", title: "Privacy", description: "Personal information is collected, used, retained, disclosed, and disposed of in conformity with commitments." },
    ],
  },
  DORA: {
    id: "DORA",
    name: "EU Digital Operational Resilience Act",
    version: "Regulation (EU) 2022/2554",
    requirements: [
      { id: "ICT_RISK_MGMT", title: "ICT risk management", description: "ICT risk management framework, asset identification, and classification are maintained." },
      { id: "INCIDENT_REPORTING", title: "ICT-related incident management, classification and reporting", description: "ICT incidents are detected, managed, classified, and reported per required timelines." },
      { id: "RESILIENCE_TESTING", title: "Digital operational resilience testing", description: "Resilience testing, including advanced testing where applicable, is performed regularly." },
      { id: "THIRD_PARTY_RISK", title: "ICT third-party risk management", description: "Risk from ICT third-party providers is identified, assessed, and monitored." },
      { id: "INFO_SHARING", title: "Information-sharing arrangements", description: "Cyber threat information is shared through appropriate arrangements where applicable." },
    ],
  },
  GDPR: {
    id: "GDPR",
    name: "EU General Data Protection Regulation",
    version: "Regulation (EU) 2016/679",
    requirements: [
      { id: "LAWFUL_BASIS", title: "Lawfulness, fairness and transparency", description: "Personal data is processed on a lawful, fair, and transparent basis." },
      { id: "DATA_MINIMIZATION", title: "Purpose limitation & data minimisation", description: "Personal data collected is adequate, relevant, and limited to what is necessary." },
      { id: "SECURITY", title: "Integrity and confidentiality", description: "Appropriate technical and organizational security measures protect personal data." },
      { id: "BREACH_NOTIFICATION", title: "Breach notification", description: "Personal data breaches are assessed and notified within required timelines where applicable." },
      { id: "DATA_SUBJECT_RIGHTS", title: "Data subject rights", description: "Processes exist to support access, rectification, erasure, and other data subject rights." },
    ],
  },
  GLBA_REG_SP: {
    id: "GLBA_REG_SP",
    name: "GLBA / SEC Regulation S-P",
    version: "17 CFR Part 248",
    requirements: [
      { id: "SAFEGUARDS", title: "Safeguarding customer information", description: "Administrative, technical, and physical safeguards protect customer records and information." },
      { id: "INCIDENT_RESPONSE", title: "Incident response program", description: "A written incident response program addresses unauthorized access to customer information." },
      { id: "CUSTOMER_NOTIFICATION", title: "Customer notification", description: "Affected individuals are notified of a breach involving sensitive customer information where required." },
      { id: "SERVICE_PROVIDER_OVERSIGHT", title: "Service provider oversight", description: "Contracts and oversight require service providers to maintain appropriate safeguards." },
    ],
  },
  SEC_IA: {
    id: "SEC_IA",
    name: "SEC Investment Adviser Requirements (reference)",
    version: "Advisers Act (selected provisions)",
    requirements: [
      { id: "RECORDKEEPING", title: "Recordkeeping", description: "Required books and records of the adviser's business are created and retained." },
      { id: "CUSTODY", title: "Custody", description: "Client funds and securities in the adviser's custody are safeguarded per applicable requirements." },
      { id: "CODE_OF_ETHICS", title: "Code of ethics & conflicts", description: "A code of ethics addresses personal trading, conflicts of interest, and fiduciary obligations." },
      { id: "COMPLIANCE_PROGRAM", title: "Compliance program", description: "Written policies and procedures reasonably designed to prevent violations are adopted and reviewed." },
    ],
  },
};

export function listFrameworks() {
  return Object.values(FRAMEWORKS).map((f) => ({
    id: f.id, name: f.name, version: f.version, requirementCount: f.requirements.length,
  }));
}

export function getFrameworkRequirements(frameworkId) {
  return FRAMEWORKS[frameworkId]?.requirements || null;
}

export function getRequirement(frameworkId, requirementId) {
  const requirements = getFrameworkRequirements(frameworkId);
  return requirements?.find((r) => r.id === requirementId) || null;
}

export async function getOrgEnabledFrameworks(orgId) {
  const { complianceOrgFrameworks } = await getOrgCollections();
  const doc = await complianceOrgFrameworks.findOne({ orgId: toObjectId(orgId) });
  return doc?.enabledFrameworkIds || [];
}

export async function setOrgEnabledFrameworks({ orgId, frameworkIds, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can change enabled frameworks.", status: 403 };
  const unknown = (frameworkIds || []).filter((id) => !FRAMEWORKS[id]);
  if (unknown.length > 0) return { error: `Unknown framework(s): ${unknown.join(", ")}.`, status: 400 };

  const { complianceOrgFrameworks } = await getOrgCollections();
  const now = new Date().toISOString();
  await complianceOrgFrameworks.updateOne(
    { orgId: toObjectId(orgId) },
    { $set: { enabledFrameworkIds: frameworkIds || [], updatedAt: now, updatedByEmail: actorEmail }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  return { enabledFrameworkIds: frameworkIds || [] };
}
