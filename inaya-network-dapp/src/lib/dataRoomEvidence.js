// src/lib/dataRoomEvidence.js
//
// Modular Enterprise Adoption Features SOW, Feature 2 (§7.7) -- Data Room
// evidence export. Reuses evidenceExporter.js's exact canonicalize/hash
// convention (the same one businessEventPassport.js already reuses) --
// one hashing technique across every Inaya feature that exports a
// verifiable package, not a new one invented per feature. Read-only:
// aggregates records that already exist (the room, its access log, its
// audit-chain entries) -- creates nothing new to track.
//
// Per §7.7, this is explicitly NOT a legal/compliance certification --
// disclosure text says so, matching every other evidence export in this
// codebase's own established discipline.

import { createHash } from "node:crypto";
import { canManageOrg } from "./orgs.js";
import { canonicalizeForExport } from "./evidenceExporter.js";
import { getDataRoom, getRoomAccessLog } from "./external-data-room.js";
import { listOrgActivityForRecord } from "./org-activity-log.js";

function sha256Hex(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

export async function exportDataRoomEvidence({ orgId, roomId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can export data room evidence.", status: 403 };
  const room = await getDataRoom(orgId, roomId);
  if (!room) return { error: "Room not found.", status: 404 };

  const [accessLog, activity] = await Promise.all([
    getRoomAccessLog(orgId, roomId),
    listOrgActivityForRecord({ orgId, recordType: "DATA_ROOM", recordId: room._id }),
  ]);

  const generatedAt = new Date().toISOString();
  const body = {
    schemaVersion: "1.0",
    roomIdentifier: room._id.toString(),
    organization: orgId.toString(),
    roomType: room.roomType,
    name: room.name,
    templateId: room.templateId ? room.templateId.toString() : null,
    sections: room.sections || [],
    ndaRequired: !!room.ndaRequired,
    resourceIdentifiers: (room.documentIds || []).map((id) => id.toString()),
    closedAt: room.closedAt,
    lifecycleEvents: activity.map((a) => ({ action: a.action, actorEmail: a.actorEmail, timestamp: a.timestamp, metadata: a.metadata })),
    accessEvents: accessLog.map((a) => ({ externalEmail: a.externalEmail, action: a.action, documentId: a.documentId ? a.documentId.toString() : null, accessedAt: a.accessedAt })),
    generatedAt,
    generatedByEmail: actorEmail,
    disclosure: "This package documents evidence that already exists in Inaya's own records for this data room. It is not a legal or regulatory compliance certification.",
  };

  const exportHash = sha256Hex(canonicalizeForExport(body));
  const { logOrgActivity } = await import("./org-activity-log.js");
  await logOrgActivity({ orgId, recordType: "DATA_ROOM", recordId: room._id, actorEmail, action: "EVIDENCE_EXPORTED", previousState: null, newState: null, metadata: { exportHash } });

  return { evidence: { ...body, exportHash } };
}
