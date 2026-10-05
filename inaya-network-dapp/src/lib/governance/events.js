// src/lib/governance/events.js
//
// File workflow triggers (Competitive Expansion SOW, WF-FILE). Governance code announces what happened to a file as a workflow event, so an
// existing `trigger.event` node with eventType "file.classified" (etc.) starts a workflow. Events carry identifiers and decisions, never
// content, and emission is best effort: a missing workflow engine never blocks the file operation.
//
// Event types: file.uploaded, file.upload_blocked, file.classified, file.classification_suggested, file.dlp_blocked, file.shared, file.share_opened

import { randomUUID } from "node:crypto";

export const FILE_EVENTS = ["file.uploaded", "file.upload_blocked", "file.classified", "file.classification_suggested", "file.dlp_blocked", "file.shared", "file.share_opened"];

export function emitFileEvent(orgId, name, payload = {}) {
  const key = `file.${name}`; if (!FILE_EVENTS.includes(key)) return;
  import("../workflows/queue.js").then((m) => m.emitWorkflowEvent({ orgId, type: "event", key, eventId: `${key}:${randomUUID()}`, payload: { file: payload } })).catch(() => {});
}
