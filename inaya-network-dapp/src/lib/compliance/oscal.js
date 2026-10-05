// src/lib/compliance/oscal.js
//
// Machine-readable evidence package (Competitive Expansion SOW P3, COMPLIANCE-003). The core is an OSCAL-SHAPED System Security Plan (OSCAL 1.1.x field names: metadata, import-profile,
// system-characteristics, system-implementation, control-implementation, back-matter). It is NOT validated against the official OSCAL JSON schema and does not claim to be: it is shaped so
// OSCAL tooling can read the common parts, with Inaya-specific facts carried in namespaced properties (ns = INAYA_NS). `checkShape` verifies the structure we promise.
//
// The package wraps that SSP with the other evidence the SOW lists: component inventory, control status, evidence references, policy versions, audit-chain verification, configuration
// snapshots (collector facts), deployment profile, data-flow description, identity integrations, vulnerability status (reported as NOT COLLECTED: Inaya does not collect it), incident and
// security events, resilience results, data residency policy, encryption mode, key-management mode and a customer-responsibility statement. Metadata only: no file content, no secrets.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canRead, listControls } from "./implementation.js";
import { collectAll } from "./collectors.js";
import { CATALOG_ID, CATALOG_VERSION, BASELINE_NOTE } from "./nist80053.js";
import { getProfile as getGovProfile, NOT_A_CERTIFICATION } from "./governmentProfile.js";

export const OSCAL_VERSION = "1.1.2";
export const INAYA_NS = "https://inayanetwork.com/ns/oscal";
export const SHAPE_NOTE = "OSCAL-shaped (1.1.x field names). Not validated against the official OSCAL schema.";
export class OscalError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** A stable UUID (version 5 layout) derived from text, so the same organization and control always get the same identifier. */
export function uuidFrom(text) {
  const h = createHash("sha1").update(String(text)).digest(); h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80; const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
const STATUS = { implemented: "implemented", partially_implemented: "partial", not_applicable: "not-applicable" };
const ORIGIN = { provider: "sp-system", customer: "customer-provided", shared: "customer-configured", inherited: "inherited" };
const prop = (name, value, ns = null) => ({ name, value: String(value), ...(ns ? { ns } : {}) });

export function buildSsp({ orgId, orgName, generatedAt, controls, profile, components, facts, keyMode, dataFlow }) {
  const resources = []; const implemented = controls.map((c) => {
    const ev = c.evidence.refs.map((r) => { const rid = uuidFrom(`${orgId}:${c.controlId}:${r.refId}`); resources.push({ uuid: rid, title: r.label || `${r.kind} evidence`, description: `Evidence reference (${r.kind}) attached to ${c.controlId}.`, props: [prop("evidence-kind", r.kind, INAYA_NS), ...(r.fingerprint ? [prop("fingerprint-sha256", r.fingerprint, INAYA_NS)] : []), ...(r.sha256 ? [prop("sha256", r.sha256, INAYA_NS)] : [])], ...(r.url ? { rlinks: [{ href: r.url }] } : {}) }); return { href: `#${rid}` }; });
    const props = [prop("control-origination", ORIGIN[c.responsibility] || "shared"), prop("assessment-state", c.implementation, INAYA_NS), prop("evidence-state", c.evidence.state, INAYA_NS), prop("status-source", c.source, INAYA_NS)]; if (STATUS[c.implementation]) props.unshift(prop("implementation-status", STATUS[c.implementation]));
    if (c.owner) props.push(prop("owner", c.owner, INAYA_NS)); if (c.exception) props.push(prop("exception", `${c.exception.state} until ${c.exception.expiresAt}`, INAYA_NS));
    return { uuid: uuidFrom(`${orgId}:${CATALOG_ID}:${c.controlId}`), "control-id": c.controlId.toLowerCase(), props, statements: [{ "statement-id": `${c.controlId.toLowerCase()}_smt`, uuid: uuidFrom(`${orgId}:${c.controlId}:smt`), remarks: c.statement, ...(ev.length ? { links: ev } : {}) }] };
  });
  return {
    "system-security-plan": {
      uuid: uuidFrom(`${orgId}:ssp`), metadata: { title: `${orgName} system security plan (readiness evidence)`, "last-modified": generatedAt, version: CATALOG_VERSION, "oscal-version": OSCAL_VERSION, remarks: `${SHAPE_NOTE} ${NOT_A_CERTIFICATION}` },
      "import-profile": { href: `#${CATALOG_ID}`, remarks: BASELINE_NOTE },
      "system-characteristics": { "system-ids": [{ id: String(orgId), "identifier-type": "https://inayanetwork.com/organization-id" }], "system-name": orgName, description: "Inaya workspace deployment for one organization.", "security-sensitivity-level": "not-categorized", "system-information": { "information-types": [{ uuid: uuidFrom(`${orgId}:info`), title: "Organization documents, messages and records", description: "Content is encrypted on the client or envelope-encrypted by the platform." }] }, "security-impact-level": { "security-objective-confidentiality": "not-categorized", "security-objective-integrity": "not-categorized", "security-objective-availability": "not-categorized" }, status: { state: "operational", remarks: `Government security profile: ${profile.label}.` }, "authorization-boundary": { description: profile.authorization?.boundary || "The Inaya workspace for this organization and the storage providers it uses. A formal authorization boundary has not been recorded." }, "data-flow": { description: dataFlow }, props: [prop("key-management", keyMode, INAYA_NS)] },
      "system-implementation": { users: [{ uuid: uuidFrom(`${orgId}:users`), title: "Organization members and external recipients", "role-ids": ["member"] }], components: components.map((c) => ({ uuid: uuidFrom(`${orgId}:component:${c.name}`), type: c.type, title: c.name, description: c.description, status: { state: "operational" }, props: [prop("responsibility", c.responsibility, INAYA_NS)] })) },
      "control-implementation": { description: `Control status tracked against the ${CATALOG_ID} internal catalog. ${BASELINE_NOTE}`, "implemented-requirements": implemented },
      "back-matter": { resources: [{ uuid: uuidFrom(`${orgId}:${CATALOG_ID}`), title: `NIST SP 800-53 Rev. 5 (internal curated catalog ${CATALOG_VERSION})`, description: BASELINE_NOTE, props: [prop("catalog-id", CATALOG_ID, INAYA_NS)] }, ...resources, ...facts.map((f) => ({ uuid: uuidFrom(`${orgId}:fact:${f.id}:${f.collectedAt}`), title: `Collector fact: ${f.label}`, description: f.summary, props: [prop("state", f.state, INAYA_NS), prop("collected-at", f.collectedAt, INAYA_NS)] }))] },
    },
  };
}
/** Structural check of what this module promises (not a schema validation). Returns a list of problems; empty means the promised structure is present. */
export function checkShape(doc) {
  const p = []; const s = doc?.["system-security-plan"]; if (!s) return ["missing system-security-plan"]; const need = (o, keys, where) => { for (const k of keys) if (o?.[k] === undefined) p.push(`${where} is missing ${k}`); };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/; if (!UUID.test(s.uuid)) p.push("ssp uuid is not a valid UUID");
  need(s, ["metadata", "import-profile", "system-characteristics", "system-implementation", "control-implementation", "back-matter"], "ssp"); need(s.metadata, ["title", "last-modified", "version", "oscal-version"], "metadata"); need(s["system-characteristics"], ["system-ids", "system-name", "description", "status", "authorization-boundary"], "system-characteristics"); need(s["system-implementation"], ["users", "components"], "system-implementation");
  const ids = new Set(); for (const r of s["control-implementation"]?.["implemented-requirements"] || []) { if (!UUID.test(r.uuid)) p.push(`requirement ${r["control-id"]} has a bad uuid`); if (!/^[a-z]{2}-\d+$/.test(r["control-id"])) p.push(`bad control-id ${r["control-id"]}`); if (ids.has(r["control-id"])) p.push(`duplicate control-id ${r["control-id"]}`); ids.add(r["control-id"]); if (!r.props?.some((x) => x.name === "control-origination")) p.push(`${r["control-id"]} has no control-origination`); }
  const resIds = new Set((s["back-matter"]?.resources || []).map((r) => r.uuid)); for (const r of s["control-implementation"]?.["implemented-requirements"] || []) for (const smt of r.statements || []) for (const l of smt.links || []) if (!resIds.has(String(l.href).replace(/^#/, ""))) p.push(`${r["control-id"]} links to a missing resource`);
  return p;
}

const COMPONENTS = [
  { name: "Inaya web application", type: "software", description: "Next.js application serving the workspace, portal and APIs.", responsibility: "provider" },
  { name: "Application hosting platform", type: "service", description: "Serverless hosting for the application. Physical and platform controls are inherited from this provider.", responsibility: "inherited" },
  { name: "Operational database", type: "service", description: "MongoDB Atlas holding organization records and the audit chain. Disk encryption and physical controls are inherited from this provider.", responsibility: "inherited" },
  { name: "Storage providers", type: "service", description: "Content-addressed storage providers holding encrypted shards (primary and replicas).", responsibility: "inherited" },
  { name: "Customer gateway agents", type: "software", description: "Optional agents running in the customer's network, connecting outbound.", responsibility: "customer" },
  { name: "Customer devices and browsers", type: "software", description: "Where client-side encryption happens.", responsibility: "customer" },
];
const DATA_FLOW = "Documents are encrypted on the client (or envelope-encrypted by the platform for the S3/Azure-compatible layer) and stored as shards at independent storage providers. The platform stores metadata and the hash-chained audit trail. Gateways connect outbound only. No file content is sent to third-party AI or office services by default.";
const RESPONSIBILITY_STATEMENT = "Inaya provides the technical capabilities and the evidence in this package. The customer is responsible for their own policies, personnel controls, risk assessment, configuration choices, the review of evidence, and any authorization decision with their authorizing body. Physical, environmental and platform controls are inherited from the hosting and storage providers, whose own attestations should be obtained. This package is not an assessment, an authorization or a certification.";

export async function buildPackage({ orgId, membership }) {
  if (!canRead(membership)) throw new OscalError(403, "Only compliance staff, administrators and auditors can export the evidence package.");
  const { db, orgs } = await getOrgCollections(); const oid = toObjectId(orgId); const org = await orgs.findOne({ _id: oid }, { projection: { name: 1 } }); const generatedAt = new Date().toISOString();
  const [{ controls }, facts, gov] = await Promise.all([listControls({ orgId, membership, limit: 1000 }), collectAll(orgId), getGovProfile({ orgId, membership: { role: "owner" } })]);
  const cfg = await db.collection("org_key_config").findOne({ orgId: oid }); const keyMode = cfg?.provider || "platform"; const dep = await db.collection("org_deployment_profile").findOne({ orgId: oid });
  const policies = await db.collection("governance_policies").find({ orgId: oid, status: "published" }).project({ name: 1, type: 1, version: 1, effectiveAt: 1, expiresAt: 1 }).limit(200).toArray(); const { listPolicies } = await import("../compliance-policies.js").catch(() => ({})); let docPolicies = []; try { docPolicies = listPolicies ? (await listPolicies(orgId, { status: "PUBLISHED" })).map?.((p) => ({ key: p.key, title: p.title, version: p.version })) || [] : []; } catch { docPolicies = []; }
  const integrations = await (async () => { try { const { getOrgIntegrations } = await import("../integrations.js"); const r = await getOrgIntegrations(orgId); return (r.integrations || r || []).map((i) => ({ providerId: i.providerId, state: i.state })); } catch { return []; } })();
  const incidents = await db.collection("incidents").countDocuments({ orgId: oid }).catch(() => null); const residency = await db.collection("data_residency_policies").findOne({ orgId: oid });
  const { inventory } = await import("../crypto/policy.js"); const crypto = await inventory(); const ssp = buildSsp({ orgId: String(orgId), orgName: org?.name || "Organization", generatedAt, controls, profile: gov, components: COMPONENTS, facts, keyMode, dataFlow: DATA_FLOW });
  const body = { kind: "inaya.compliance-evidence-package", version: 1, generatedAt, notice: `${NOT_A_CERTIFICATION} ${SHAPE_NOTE}`, systemDescription: { name: org?.name || null, summary: "Inaya workspace deployment for one organization.", dataFlow: DATA_FLOW }, componentInventory: COMPONENTS, controlStatus: controls.map((c) => ({ controlId: c.controlId, title: c.title, implementation: c.implementation, responsibility: c.responsibility, owner: c.owner, evidenceState: c.evidence.state, exception: c.exception ? { state: c.exception.state, expiresAt: c.exception.expiresAt } : null, source: c.source })),
    evidenceReferences: controls.flatMap((c) => c.evidence.refs.map((r) => ({ controlId: c.controlId, ...r }))), policyVersions: { governance: policies.map((p) => ({ name: p.name, type: p.type, version: p.version, effectiveAt: p.effectiveAt, expiresAt: p.expiresAt })), documents: docPolicies }, auditChainVerification: facts.find((f) => f.id === "auditChain") || null,
    configurationSnapshots: facts, deploymentProfile: { mode: dep?.mode || "cloud_managed", governmentProfile: { state: gov.state, label: gov.label, technicalChecks: { met: gov.technicalChecks.met, total: gov.technicalChecks.total } } }, identityIntegrations: integrations,
    vulnerabilityStatus: { state: "NOT_COLLECTED", note: "Inaya does not collect vulnerability scan results. Attach scan reports as evidence." }, incidentsAndSecurityEvents: { incidentRecords: incidents, signals: facts.find((f) => f.id === "monitoring")?.details || null }, resilienceResults: { recovery: facts.find((f) => f.id === "resilience") || null, replication: facts.find((f) => f.id === "replication") || null },
    dataResidencyPolicy: residency ? { recorded: true, policyId: String(residency._id) } : { recorded: false }, encryptionMode: facts.find((f) => f.id === "encryption")?.details || null, keyManagementMode: keyMode, cryptography: { mode: crypto.mode, fips: crypto.fips, usage: crypto.usage.map((u) => ({ subsystem: u.subsystem, algorithms: u.algorithms, allApproved: u.allApproved })), dependencies: crypto.dependencies }, customerResponsibilityStatement: RESPONSIBILITY_STATEMENT, oscal: ssp };
  const problems = checkShape(ssp); const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, shapeCheck: { ok: problems.length === 0, problems }, sha256 };
}
