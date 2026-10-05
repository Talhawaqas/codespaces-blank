// src/lib/gateway/modes.js
//
// Data sovereignty modes (Competitive Expansion SOW GATEWAY-003). Explicit, recorded per organization, with a readiness verdict computed from what is really
// configured. Mode 4 (air-gapped) is RECORDED ONLY: no architecture for it exists, nothing has been tested, and the product makes no claim of
// internet-independent operation.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { ObjectId } from "mongodb";
import { GatewayError, gwCols, statusOf } from "./gateway.js";

const fail = (status, message) => { throw new GatewayError(status, message); };
export const MODES = {
  cloud_managed: { n: 1, label: "Cloud managed", text: "Data is stored through Inaya's cloud storage." },
  customer_storage: { n: 2, label: "Customer-controlled storage", text: "The customer controls the storage provider; Inaya manages control metadata and security policy." },
  customer_gateway: { n: 3, label: "Customer gateway with Inaya orchestration", text: "A gateway in the customer's network handles local data access; Inaya provides identity, policy, evidence, audit and optional encrypted synchronization." },
  air_gapped: { n: 4, label: "Air-gapped or disconnected", text: "Recorded as a requirement only. No disconnected architecture exists yet, and no internet-independent operation is claimed or tested." },
};

async function readiness(orgId) {
  const { backupCredentials } = await getOrgCollections(); const c = await gwCols(); const oid = toObjectId(orgId);
  const creds = await backupCredentials.countDocuments({ orgId: oid }).catch(() => 0);
  const gws = await c.gateways.find({ orgId: oid, status: "active" }).toArray(); const online = gws.filter((g) => statusOf(g) === "ONLINE").length;
  return {
    cloud_managed: { state: "READY", note: "Available to every organization." },
    customer_storage: creds ? { state: "PARTIAL", note: `${creds} storage credential(s) are configured and can receive backups. Documents uploaded in the workspace are still stored through Inaya-managed storage; customer-controlled storage is not yet used for them.` } : { state: "NOT_CONFIGURED", note: "No customer storage credential is configured (Settings, backups)." },
    customer_gateway: online ? { state: "READY", note: `${online} gateway(s) online.` } : gws.length ? { state: "NOT_READY", note: "A gateway is registered but none is online." } : { state: "NOT_CONFIGURED", note: "No gateway is registered." },
    air_gapped: { state: "RECORDED_ONLY", note: "Nothing is built or tested for disconnected operation." },
  };
}

export async function getProfile({ orgId }) {
  const { db } = await getOrgCollections(); const row = await db.collection("org_deployment_profile").findOne({ orgId: toObjectId(orgId) }); const r = await readiness(orgId); const mode = row?.mode || "cloud_managed";
  return { mode, setAt: row?.setAt || null, setBy: row?.setBy || null, note: row?.note || null, modes: Object.entries(MODES).map(([key, m]) => ({ key, ...m, readiness: r[key] })), current: { key: mode, ...MODES[mode], readiness: r[mode] } };
}
export async function setMode({ orgId, membership, actorEmail, mode, note = null, acknowledgeNoClaim = false }) {
  if (!canManageOrg(membership)) fail(403, "Only an owner or admin can change the deployment mode.");
  if (!MODES[mode]) fail(400, `mode must be one of ${Object.keys(MODES).join(", ")}.`);
  if (mode === "air_gapped" && acknowledgeNoClaim !== true) fail(400, "Air-gapped is recorded as a requirement only. Confirm that you understand no disconnected operation is provided (acknowledgeNoClaim).");
  const { db } = await getOrgCollections(); const prev = (await db.collection("org_deployment_profile").findOne({ orgId: toObjectId(orgId) }))?.mode || "cloud_managed";
  await db.collection("org_deployment_profile").updateOne({ orgId: toObjectId(orgId) }, { $set: { mode, note: note ? String(note).slice(0, 300) : null, setBy: actorEmail, setAt: new Date().toISOString() } }, { upsert: true });
  await logOrgActivity({ orgId, recordType: "GATEWAY", recordId: new ObjectId(), actorEmail, action: "DEPLOYMENT_MODE_SET", previousState: prev, newState: mode, metadata: {} }).catch(() => {});
  return getProfile({ orgId });
}
