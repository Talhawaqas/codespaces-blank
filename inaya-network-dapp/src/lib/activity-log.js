// src/lib/activity-log.js
//
// The one function that writes to document_activity — factored out of
// document-workflow.js into its own module so document-permissions.js can
// use it too without a circular import (document-workflow.js already
// imports permission-resolution helpers from document-permissions.js;
// having document-permissions.js import logging back from
// document-workflow.js would create a cycle). document-workflow.js
// re-exports this for backward compatibility with existing imports.
//
// Append-only: this is the only code path in the codebase that writes to
// document_activity, and it only ever inserts. Don't add an update/delete
// path for this collection.

import { randomUUID } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";

export async function logDocumentActivity({ organizationId, documentId, actorId, action, previousState, newState, metadata }) {
  const { documentActivity } = await getOrgCollections();
  const event = {
    eventId: randomUUID(),
    organizationId: toObjectId(organizationId),
    documentId: toObjectId(documentId),
    actorId,
    action,
    previousState: previousState ?? null,
    newState: newState ?? null,
    timestamp: new Date().toISOString(),
    metadata: metadata || {},
  };
  await documentActivity.insertOne(event);
  return event;
}
