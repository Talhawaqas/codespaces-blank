// src/lib/board-management.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§36) — Board
// Management. "private_capital" vertical only.
//
// "Board records require elevated permissions and strong retention" (§36)
// -- unlike most Phase 2/3 records, board data is gated on
// canManageFinancialEntities (manager/owner/admin) for READS too, not the
// broader canAccessFinancialEntities staff tier every other module here
// uses. This is a deliberate, narrower access model, not an oversight.
//
// Two collections: board_meetings (calendar/agenda/attendance/minutes/
// action items/conflicts) and board_resolutions (voting), kept separate
// because a meeting's lifecycle and a resolution's vote tally are
// different concerns that shouldn't be conflated into one document.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const BOARD_MEETING_STATES = ["SCHEDULED", "AGENDA_SET", "HELD", "MINUTES_DRAFTED", "MINUTES_APPROVED"];
export const BOARD_MEETING_TRANSITIONS = {
  setAgenda: { from: "SCHEDULED", to: "AGENDA_SET", activityAction: "AGENDA_SET" },
  hold: { from: "AGENDA_SET", to: "HELD", activityAction: "HELD" },
  draftMinutes: { from: "HELD", to: "MINUTES_DRAFTED", activityAction: "MINUTES_DRAFTED" },
  approveMinutes: { from: "MINUTES_DRAFTED", to: "MINUTES_APPROVED", activityAction: "MINUTES_APPROVED" },
};

function requireBoardAccess(membership) {
  return canManageFinancialEntities(membership) ? null : { error: "Board records require elevated (financial-entities manager or org owner/admin) permission.", status: 403 };
}

export async function createBoardMeeting({ orgId, portfolioCompanyId, scheduledAt, actorEmail, membership }) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  if (!scheduledAt) return { error: "scheduledAt is required.", status: 400 };

  const { boardMeetings } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), portfolioCompanyId: toObjectId(portfolioCompanyId), scheduledAt,
    agenda: [], attendees: [], minutesText: null, actionItems: [], conflicts: [],
    status: "SCHEDULED",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await boardMeetings.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "BOARD_MEETING", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "SCHEDULED", metadata: { portfolioCompanyId } });
  return { meeting: inserted };
}

export async function setAgenda({ orgId, meetingId, agendaItems, actorEmail, membership }) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  return transitionMeeting({ orgId, meetingId, action: "setAgenda", actorEmail, membership, extraSet: { agenda: agendaItems || [] } });
}

async function transitionMeeting({ orgId, meetingId, action, actorEmail, membership, extraSet }) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  const definition = BOARD_MEETING_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { boardMeetings } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const meetingObjectId = toObjectId(meetingId);
  const now = new Date().toISOString();

  const updated = await boardMeetings.findOneAndUpdate(
    { _id: meetingObjectId, orgId: orgObjectId, status: definition.from },
    { $set: { status: definition.to, updatedAt: now, ...(extraSet || {}) } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await boardMeetings.findOne({ _id: meetingObjectId, orgId: orgObjectId });
    if (!current) return { error: "Board meeting not found.", status: 404 };
    return { error: `This meeting isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "BOARD_MEETING", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: {} });
  return { meeting: updated };
}

export async function holdMeeting({ orgId, meetingId, attendees, actorEmail, membership }) {
  return transitionMeeting({ orgId, meetingId, action: "hold", actorEmail, membership, extraSet: { attendees: attendees || [] } });
}
export async function draftMinutes({ orgId, meetingId, minutesText, actorEmail, membership }) {
  if (!minutesText?.trim()) return { error: "Minutes text is required.", status: 400 };
  return transitionMeeting({ orgId, meetingId, action: "draftMinutes", actorEmail, membership, extraSet: { minutesText: minutesText.trim() } });
}
export async function approveMinutes({ orgId, meetingId, actorEmail, membership }) {
  return transitionMeeting({ orgId, meetingId, action: "approveMinutes", actorEmail, membership });
}

/** Append-only, matching every other "log of events" shape in this
 *  codebase -- an action item is never silently removed, only completed. */
export async function addActionItem({ orgId, meetingId, description, ownerEmail, dueDate, actorEmail, membership }) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  if (!description?.trim()) return { error: "A description is required.", status: 400 };
  const { boardMeetings } = await getOrgCollections();
  const now = new Date().toISOString();
  const item = { description: description.trim(), ownerEmail: ownerEmail || null, dueDate: dueDate || null, status: "open", createdAt: now };

  const updated = await boardMeetings.findOneAndUpdate(
    { _id: toObjectId(meetingId), orgId: toObjectId(orgId) },
    { $push: { actionItems: item }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Board meeting not found.", status: 404 };
  return { meeting: updated };
}

export async function recordConflict({ orgId, meetingId, memberEmail, description, actorEmail, membership }) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  if (!memberEmail || !description?.trim()) return { error: "memberEmail and description are required.", status: 400 };
  const { boardMeetings } = await getOrgCollections();
  const now = new Date().toISOString();
  const conflict = { memberEmail, description: description.trim(), recordedByEmail: actorEmail, recordedAt: now };

  const updated = await boardMeetings.findOneAndUpdate(
    { _id: toObjectId(meetingId), orgId: toObjectId(orgId) },
    { $push: { conflicts: conflict }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Board meeting not found.", status: 404 };
  return { meeting: updated };
}

export async function listBoardMeetings(orgId, portfolioCompanyId, membership) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  const { boardMeetings } = await getOrgCollections();
  return { meetings: await boardMeetings.find({ orgId: toObjectId(orgId), portfolioCompanyId: toObjectId(portfolioCompanyId) }).sort({ scheduledAt: -1 }).toArray() };
}

// ============================================================
// RESOLUTIONS & VOTING
// ============================================================
export const RESOLUTION_STATES = ["PROPOSED", "VOTING_CLOSED"];

export async function proposeResolution({ orgId, meetingId, title, description, actorEmail, membership }) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  if (!title?.trim()) return { error: "A resolution title is required.", status: 400 };

  const { boardResolutions } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), meetingId: toObjectId(meetingId), title: title.trim(), description: description || null,
    votes: [], status: "PROPOSED", outcome: null, closedAt: null,
    proposedByEmail: actorEmail, createdAt: now,
  };
  const result = await boardResolutions.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "BOARD_RESOLUTION", recordId: inserted._id, actorEmail, action: "PROPOSED", previousState: null, newState: "PROPOSED", metadata: { title: doc.title } });
  return { resolution: inserted };
}

/** Idempotent per voter -- casting again replaces that voter's own prior
 *  vote (a change of mind before voting closes), never adds a duplicate. */
export async function castVote({ orgId, resolutionId, voterEmail, vote, actorEmail, membership }) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  if (!["approve", "reject", "abstain"].includes(vote)) return { error: `Unknown vote "${vote}".`, status: 400 };

  const { boardResolutions } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const resolutionObjectId = toObjectId(resolutionId);
  const current = await boardResolutions.findOne({ _id: resolutionObjectId, orgId: orgObjectId });
  if (!current) return { error: "Resolution not found.", status: 404 };
  if (current.status !== "PROPOSED") return { error: "Voting is closed on this resolution.", status: 409 };

  const now = new Date().toISOString();
  const votes = current.votes.filter((v) => v.voterEmail !== voterEmail);
  votes.push({ voterEmail, vote, votedAt: now });

  const updated = await boardResolutions.findOneAndUpdate(
    { _id: resolutionObjectId, orgId: orgObjectId, status: "PROPOSED" },
    { $set: { votes } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Voting is closed on this resolution.", status: 409 };
  return { resolution: updated };
}

/** Tallies the votes cast so far and finalizes the resolution -- simple
 *  majority of approve vs. reject among non-abstain votes. */
export async function closeVoting({ orgId, resolutionId, actorEmail, membership }) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  const { boardResolutions } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const resolutionObjectId = toObjectId(resolutionId);
  const current = await boardResolutions.findOne({ _id: resolutionObjectId, orgId: orgObjectId });
  if (!current) return { error: "Resolution not found.", status: 404 };
  if (current.status !== "PROPOSED") return { error: "This resolution's voting is already closed.", status: 409 };

  const approve = current.votes.filter((v) => v.vote === "approve").length;
  const reject = current.votes.filter((v) => v.vote === "reject").length;
  const outcome = approve > reject ? "PASSED" : "FAILED";

  const now = new Date().toISOString();
  const updated = await boardResolutions.findOneAndUpdate(
    { _id: resolutionObjectId, orgId: orgObjectId, status: "PROPOSED" },
    { $set: { status: "VOTING_CLOSED", outcome, closedAt: now, closedByEmail: actorEmail } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This resolution's voting is already closed.", status: 409 };

  await logOrgActivity({ orgId, recordType: "BOARD_RESOLUTION", recordId: resolutionObjectId, actorEmail, action: "VOTING_CLOSED", previousState: "PROPOSED", newState: outcome, metadata: { approve, reject } });
  return { resolution: updated };
}

export async function listResolutions(orgId, meetingId, membership) {
  const denied = requireBoardAccess(membership);
  if (denied) return denied;
  const { boardResolutions } = await getOrgCollections();
  return { resolutions: await boardResolutions.find({ orgId: toObjectId(orgId), meetingId: toObjectId(meetingId) }).sort({ createdAt: -1 }).toArray() };
}
