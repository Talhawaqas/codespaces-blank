// src/lib/nas/tiering.js
//
// Sovereign NAS SOW Workstream P (intelligent storage tiering).
//
//   HOT        local NAS
//   WARM       local NAS + a verified copy in Inaya (copy tier)
//   COLD       Inaya only; the local file is replaced by a small stub
//   IMMUTABLE  WORM / locked repository (see snapshots.js)
//
// SOW rule: "The first implementation must not silently move user data.
// Policies should be visible, auditable and reversible." So:
//   1. A policy only ever produces PROPOSALS (evaluateTiering is read-only).
//   2. Applying a proposal needs approval from a NAS manager other than the
//      proposer (segregation of duties; an AI-originated proposal always needs
//      a human approver).
//   3. Applying first copies to Inaya and re-reads the copy to verify its
//      sha256. Only COLD removes the local file, and only after that verify;
//      a stub records exactly where the data went.
//   4. recallProposal restores every file from Inaya, verifying hashes, and
//      removes the stubs -- fully reversible.
// Files under a legal hold path are never proposed. Age is measured from
// modification time (DERIVED: access time is unreliable under relatime).

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId, canManageOrg } from "../orgs.js";
import { fail, gate, loadShare, iso } from "./common.js";
import { recordNasEvidence } from "./evidence.js";
import { getTargetAdapter, INAYA_TARGET_ID } from "./cloudTargets.js";
import { putBucketVersioning, getS3Bucket } from "../s3-compat/store.js";

export const TIERS = ["WARM", "COLD"];
const STUB_SUFFIX = ".inaya-tiered.json";
const MAX_PROPOSAL_FILES = 500;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export async function setTieringPolicy({ orgId, shareId, rules, legalHoldPaths = [], membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 10) return fail("rules must be an array of 1-10 rules.");
  const clean = [];
  for (const r of rules) {
    if (!TIERS.includes(r?.tier) || !(Number(r.olderThanDays) >= 0)) return fail("Each rule needs tier WARM|COLD and olderThanDays >= 0.");
    clean.push({ tier: r.tier, olderThanDays: Number(r.olderThanDays), minSizeBytes: Math.max(0, Number(r.minSizeBytes) || 0), pathPrefix: r.pathPrefix ? String(r.pathPrefix).replace(/^\/+/, "").slice(0, 200) : null });
  }
  const holds = (legalHoldPaths || []).map((p) => String(p).replace(/^\/+|\/+$/g, "")).filter((p) => p && !p.split("/").includes(".."));
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const tiering = { rules: clean, legalHoldPaths: holds, updatedAt: iso(), updatedBy: actorEmail };
  const { nasShares } = await getOrgCollections();
  await nasShares.updateOne({ _id: res.share._id }, { $set: { tiering } });
  await recordNasEvidence({ orgId, applianceId: res.share.applianceId, subjectId: res.share._id, action: "POLICY_CHANGED", actorEmail, policy: { kind: "tiering", rules: clean, legalHoldPaths: holds }, data: { change: "tiering-policy" }, graph: false });
  return { tiering };
}

/** Pure. */
export function isUnderLegalHold(rel, holds = []) {
  return holds.some((h) => rel === h || rel.startsWith(h + "/"));
}

/** Read-only: what WOULD move. Creates a stored proposal for review. */
export async function proposeTiering({ orgId, shareId, proposedBy = "policy", actorType = "human", membership, actorEmail, removeLocal }) {
  if (actorType !== "ai") { const denied = gate(membership, true); if (denied) return denied; }
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  const policy = share.tiering;
  if (!policy?.rules?.length) return fail("This share has no tiering policy.", 400);
  const { nasTieringProposals } = await getOrgCollections();
  const proposals = [];
  for (const rule of policy.rules) {
    const r = await agent.call("tier_candidates", { share: share.shareName, olderThanDays: rule.olderThanDays, minSizeBytes: rule.minSizeBytes, limit: MAX_PROPOSAL_FILES }, { timeout: 300000 });
    const files = r.candidates.filter((f) => !f.relativePath.endsWith(STUB_SUFFIX) && !isUnderLegalHold(f.relativePath, policy.legalHoldPaths) && (!rule.pathPrefix || f.relativePath.startsWith(rule.pathPrefix)) && f.sizeBytes <= MAX_FILE_BYTES);
    if (!files.length) continue;
    const doc = {
      orgId: toObjectId(orgId), shareId: share._id, applianceId: share.applianceId, tier: rule.tier, rule, files: files.map((f) => ({ relativePath: f.relativePath, sizeBytes: f.sizeBytes, ageDays: f.ageDays })),
      totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0), removeLocal: rule.tier === "COLD" ? (removeLocal ?? true) : false, basis: r.basis, state: "PROPOSED",
      estimatedLocalSavingsBytes: rule.tier === "COLD" ? files.reduce((n, f) => n + f.sizeBytes, 0) : 0, estimateLabel: "DERIVED", proposedBy: actorType === "ai" ? "ai" : actorEmail || proposedBy, proposedByType: actorType, createdAt: iso(),
    };
    const ins = await nasTieringProposals.insertOne(doc);
    proposals.push({ ...doc, _id: ins.insertedId });
    await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "TIER_PROPOSED", actorEmail: actorEmail || "system", actorType, data: { proposalId: String(ins.insertedId), tier: rule.tier, files: files.length, totalBytes: doc.totalBytes }, graph: false });
  }
  return { proposals };
}

export async function listTieringProposals({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasTieringProposals } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (shareId) q.shareId = toObjectId(shareId);
  return { proposals: await nasTieringProposals.find(q, { projection: { "files": 0 } }).sort({ createdAt: -1 }).limit(100).toArray() };
}

export async function decideTiering({ orgId, proposalId, approve, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasTieringProposals } = await getOrgCollections();
  const p = await nasTieringProposals.findOne({ _id: toObjectId(proposalId), orgId: toObjectId(orgId) });
  if (!p) return fail("Proposal not found.", 404);
  if (p.state !== "PROPOSED") return fail(`This proposal is already ${p.state}.`, 409);
  if (approve && p.proposedBy === actorEmail) return fail("A proposal must be approved by a different manager (segregation of duties).", 403);
  await nasTieringProposals.updateOne({ _id: p._id, state: "PROPOSED" }, { $set: { state: approve ? "APPROVED" : "REJECTED", decidedBy: actorEmail, decidedAt: iso() } });
  return { state: approve ? "APPROVED" : "REJECTED" };
}

async function ensureVersioned(orgId, bucket) {
  try { const b = await getS3Bucket({ orgId, bucket }); if (!b || b.versioningStatus !== "Enabled") await putBucketVersioning({ orgId, bucket, status: "Enabled" }); } catch { /* best effort */ }
}

export async function applyTiering({ orgId, proposalId, targetId = INAYA_TARGET_ID, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasTieringProposals } = await getOrgCollections();
  const p = await nasTieringProposals.findOneAndUpdate({ _id: toObjectId(proposalId), orgId: toObjectId(orgId), state: "APPROVED" }, { $set: { state: "APPLYING", applyStartedAt: iso() } }, { returnDocument: "after" });
  const proposal = p?.value ?? p;
  if (!proposal) return fail("Only an approved proposal can be applied.", 409);
  const res = await loadShare({ orgId, shareId: proposal.shareId });
  if (res.error) { await nasTieringProposals.updateOne({ _id: proposal._id }, { $set: { state: "APPROVED" } }); return res; }
  const { share, appliance, agent } = res;
  let adapter;
  try { adapter = await getTargetAdapter({ orgId, appliance, targetId, actorEmail }); } catch (err) { await nasTieringProposals.updateOne({ _id: proposal._id }, { $set: { state: "APPROVED" } }); return fail(err.message, 400); }
  if (adapter.kind === "inaya-sovereign") await ensureVersioned(orgId, adapter.bucket);

  const applied = [];
  const failures = [];
  for (const f of proposal.files) {
    try {
      const buf = await agent.readFile({ shareName: share.shareName, relativePath: f.relativePath });
      const sha = createHash("sha256").update(buf).digest("hex");
      const put = await adapter.put({ key: `${share.shareName}/.tiered/${f.relativePath}`, buffer: buf, contentType: "application/octet-stream" });
      const back = await adapter.get({ key: put.objectKey, versionId: put.versionId });
      if (!back || createHash("sha256").update(back).digest("hex") !== sha) throw new Error("The copy in Inaya did not verify; the local file was not touched.");
      const entry = { relativePath: f.relativePath, sizeBytes: buf.length, sha256: sha, objectKey: put.objectKey, versionId: put.versionId, targetKey: adapter.targetKey };
      if (proposal.removeLocal) {
        await agent.writeFile({ shareName: share.shareName, relativePath: f.relativePath + STUB_SUFFIX, buffer: Buffer.from(JSON.stringify({ inayaTiered: 1, ...entry })) });
        await agent.call("delete_file", { share: share.shareName, relPath: f.relativePath });
      }
      applied.push(entry);
    } catch (err) {
      failures.push({ relativePath: f.relativePath, error: String(err.message).slice(0, 200) });
    }
  }
  const state = failures.length === 0 ? "APPLIED" : applied.length ? "APPLIED_WITH_ERRORS" : "APPROVED";
  await nasTieringProposals.updateOne({ _id: proposal._id }, { $set: { state, applied, failures, appliedAt: iso(), appliedBy: actorEmail, targetKey: adapter.targetKey } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "TIER_APPLIED", actorEmail, result: state, data: { proposalId: String(proposal._id), tier: proposal.tier, files: applied.length, failed: failures.length, removedLocal: !!proposal.removeLocal } });
  return { state, applied: applied.length, failures };
}

/** Reversal: bring every file back from Inaya (hash-verified) and drop the stubs. */
export async function recallProposal({ orgId, proposalId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasTieringProposals } = await getOrgCollections();
  const proposal = await nasTieringProposals.findOne({ _id: toObjectId(proposalId), orgId: toObjectId(orgId), state: { $in: ["APPLIED", "APPLIED_WITH_ERRORS"] } });
  if (!proposal) return fail("Only an applied proposal can be recalled.", 409);
  const res = await loadShare({ orgId, shareId: proposal.shareId });
  if (res.error) return res;
  const { share, appliance, agent } = res;
  let adapter;
  try { adapter = await getTargetAdapter({ orgId, appliance, targetId: proposal.targetKey, actorEmail }); } catch (err) { return fail(err.message, 400); }
  const recalled = [];
  const failures = [];
  for (const e of proposal.applied || []) {
    try {
      if (proposal.removeLocal) {
        const buf = await adapter.get({ key: e.objectKey, versionId: e.versionId });
        if (!buf || createHash("sha256").update(buf).digest("hex") !== e.sha256) throw new Error("The archived copy does not match its recorded hash; it was not restored.");
        await agent.writeFile({ shareName: share.shareName, relativePath: e.relativePath, buffer: buf });
        await agent.call("delete_file", { share: share.shareName, relPath: e.relativePath + STUB_SUFFIX });
      }
      recalled.push(e.relativePath);
    } catch (err) {
      failures.push({ relativePath: e.relativePath, error: String(err.message).slice(0, 200) });
    }
  }
  await nasTieringProposals.updateOne({ _id: proposal._id }, { $set: { state: failures.length ? proposal.state : "REVERTED", recalledAt: iso(), recalledBy: actorEmail } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "TIER_RECALLED", actorEmail, result: failures.length ? "PARTIAL" : "OK", data: { proposalId: String(proposal._id), recalled: recalled.length, failed: failures.length } });
  return { recalled: recalled.length, failures };
}
