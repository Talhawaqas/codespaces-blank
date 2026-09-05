// src/lib/training.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§4.13) — policy publication /
// training assignment / acknowledgement. `policyKey` links back to an
// industry_policies row (policy-engine.js) or is a free-form string for
// training that isn't tied to a specific automated policy rule (e.g. a
// general security-awareness course) — kept loose deliberately since not
// every org will run policy-engine.js rules for every trained topic.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export async function assignTraining({ orgId, policyKey, title, memberEmails, dueDate, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can assign training.", status: 403 };
  const { trainingRecords } = await getOrgCollections();
  const now = new Date().toISOString();
  const docs = memberEmails.map((memberEmail) => ({
    orgId: toObjectId(orgId), policyKey, title, memberEmail,
    dueDate: dueDate || null, acknowledgedAt: null, completedAt: null, expiresAt: null,
    assignedByEmail: actorEmail, createdAt: now, updatedAt: now,
  }));
  if (!docs.length) return { assigned: [] };
  const result = await trainingRecords.insertMany(docs);
  const inserted = docs.map((d, i) => ({ ...d, _id: result.insertedIds[i] }));

  await Promise.all(
    inserted.map((rec) =>
      createNotification({
        scope: "org", orgId, targetEmail: rec.memberEmail, category: "compliance_control", severity: "info",
        type: "training_assigned", title: `Training assigned: ${title}`, body: dueDate ? `Due ${dueDate}` : "",
        sourceModule: "training", sourceId: rec._id, actionUrl: "/business?view=trustCenter",
        dedupeKey: `${orgId}:training_assigned:${rec._id}`,
      })
    )
  );
  await logOrgActivity({ orgId, recordType: "TRAINING", recordId: result.insertedIds[0], actorEmail, action: "ASSIGNED", previousState: null, newState: "assigned", metadata: { policyKey, title, count: docs.length } });
  return { assigned: inserted };
}

export async function acknowledgeTraining({ orgId, trainingRecordId, actorEmail }) {
  const { trainingRecords } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await trainingRecords.findOneAndUpdate(
    { _id: toObjectId(trainingRecordId), orgId: toObjectId(orgId), memberEmail: actorEmail, acknowledgedAt: null },
    { $set: { acknowledgedAt: now, completedAt: now, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Training record not found, or already acknowledged.", status: 404 };
  await logOrgActivity({ orgId, recordType: "TRAINING", recordId: updated._id, actorEmail, action: "ACKNOWLEDGED", previousState: "assigned", newState: "acknowledged", metadata: {} });
  return { training: updated };
}

export async function listTrainingFor(orgId, memberEmail) {
  const { trainingRecords } = await getOrgCollections();
  return trainingRecords.find({ orgId: toObjectId(orgId), memberEmail }).sort({ dueDate: 1 }).toArray();
}

export async function listAllTraining(orgId) {
  const { trainingRecords } = await getOrgCollections();
  return trainingRecords.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).toArray();
}
