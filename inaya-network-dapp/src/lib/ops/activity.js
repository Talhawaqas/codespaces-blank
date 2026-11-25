// src/lib/ops/activity.js -- Manage Orders SOW sections 9-10: job activity (labour) kept SEPARATE from attendance,
// evidence, the technician's day, and the manager exception queue.
//
// Attendance stays in workforce/time.js (punches, breaks, corrections). This file records what a technician does on a
// specific job: ACK, START, PAUSE (reason code), RESUME, SUBMIT, FLAG; corrections are new CORRECTION events, never edits.
// Every event: server timestamp (device time is ignored), unique idempotency key (a retried request records once),
// assignment + job-state + branch validated on the server, device/app version stored when sent.
// Location (SOW 9.3) is event-based only (at start/finish), only when the company switched it on, and a site distance
// mismatch creates a REVIEW item, never a verdict. A site code (QR) is the alternative. Exceptions are review signals:
// nothing here deducts pay, disciplines anyone or labels anyone fraudulent.
import { getOrgCollections } from "../orgs.js";
import { K as WK, myStatus } from "../workforce/time.js";
import { ccol, oid, sid, clean, fail, nowIso, K, opsAccess, can, opsRoleOf, getOpsSettings, audit, notifyMember, minutesBetween, newId, scopeFilter, opsEntitled } from "./core.js";
import { loadJob, viewFor, ensureOpsIndexes, TERMINAL, isTech } from "./jobs.js";

export const PAUSE_REASONS = ["break", "parts", "tools", "customer_approval", "technical_review", "safety", "end_of_shift", "other"];
export const FLAG_KINDS = ["blocker", "safety", "customer_approval", "parts"];
const START_OK = { WO: ["ASSIGNED", "IN_PROGRESS", "AWAITING_PARTS"], RO: ["SCHEDULED", "IN_REPAIR", "AWAITING_PARTS"] };
const WORKING = { WO: "IN_PROGRESS", RO: "IN_REPAIR" };

function distanceM(a, b) {
  const R = 6371000, r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
const validGeo = (g) => g && Number.isFinite(Number(g.lat)) && Number.isFinite(Number(g.lng)) && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180;

async function raise({ orgId, type, key, email = null, jobId = null, rule, evidence = {}, severity = "warning" }) {
  const c = await ccol(); const now = nowIso();
  try {
    const r = await c.insertOne({ orgId: oid(orgId), kind: K.exc, opsDoc: true, opsKey: `exc:${type}:${key}`, type, email, jobId: oid(jobId), rule, evidence, status: "OPEN", severity, actions: [], createdAt: now, updatedAt: now, at: now });
    const s = await getOpsSettings(orgId);
    const { orgMembers } = await getOrgCollections();
    const mgrs = await orgMembers.find({ orgId: oid(orgId), status: "active", $or: [{ opsRole: "manager" }, { role: { $in: ["owner", "admin"] } }] }, { projection: { email: 1 } }).limit(20).toArray();
    for (const m of mgrs) await notifyMember({ orgId, email: m.email, title: "Manage Orders: item to review", body: rule, type: "ops_exception", sourceId: r.insertedId, dedupeKey: `ops:exc:${type}:${key}:${m.email}`, severity: "warning" });
    void s; return r.insertedId;
  } catch (e) { if (e?.code === 11000) return null; throw e; }
}

/** Recompute a worker's active minutes from the event stream (START/RESUME -> PAUSE/SUBMIT), plus approved corrections. */
export function labourFromEvents(events, now = new Date()) {
  const per = new Map();
  for (const ev of [...events].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const p = per.get(ev.email) || { minutes: 0, openAt: null, pausedMinutes: 0, pauseAt: null };
    if (["START", "RESUME"].includes(ev.type)) { if (!p.openAt) p.openAt = ev.at; if (p.pauseAt) { p.pausedMinutes += minutesBetween(p.pauseAt, ev.at); p.pauseAt = null; } }
    else if (["PAUSE", "SUBMIT"].includes(ev.type)) { if (p.openAt) { p.minutes += minutesBetween(p.openAt, ev.at); p.openAt = null; } if (ev.type === "PAUSE") p.pauseAt = ev.at; }
    else if (ev.type === "CORRECTION" && Number.isFinite(ev.minutesDelta)) p.minutes = Math.max(0, p.minutes + ev.minutesDelta);
    per.set(ev.email, p);
  }
  const out = {}; for (const [e, p] of per) out[e] = { minutes: p.minutes + (p.openAt ? minutesBetween(p.openAt, now) : 0), pausedMinutes: p.pausedMinutes + (p.pauseAt ? minutesBetween(p.pauseAt, now) : 0), running: !!p.openAt };
  return out;
}

/**
 * One job-activity event by the assigned technician (or, with `onBehalfOf`, by a manager with a reason).
 * input: { type: ACK|START|PAUSE|RESUME|SUBMIT|FLAG, reason?, note?, idempotencyKey, location?{lat,lng,accuracy}, siteCode?, device?{platform,app,version} }
 */
export async function recordActivity({ orgId, membership, actorEmail, jobId, input = {} }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d; await ensureOpsIndexes();
  const type = String(input.type || "").toUpperCase(); if (!["ACK", "START", "PAUSE", "RESUME", "SUBMIT", "FLAG"].includes(type)) return fail("Unknown job action.");
  const idem = String(input.idempotencyKey || ""); if (!/^[A-Za-z0-9_-]{12,80}$/.test(idem)) return fail("Missing request key; reload and try again.");
  const c = await ccol();
  const dup = await c.findOne({ orgId: oid(orgId), opsKey: `act:${idem}` }); if (dup) return { event: actView(dup), duplicate: true };
  const r = await loadJob({ orgId, membership, jobId });
  if (r.error) { if (r.status === 404 && isTech(membership)) await raise({ orgId, type: "UNAUTHORIZED_ATTEMPT", key: `${actorEmail}:${jobId}:${new Date().toISOString().slice(0, 13)}`, email: actorEmail, rule: "A job action was attempted on a job the person isn't assigned to.", evidence: { jobId: sid(jobId), action: type } }); return r; }
  const j = r.job;
  let email = actorEmail; let onBehalf = null;
  if (input.onBehalfOf) {
    if (!can(membership, "approve")) return fail("Only a manager can record work for someone else.", 403);
    const why = clean(input.reason, 300); if (why.length < 3) return fail("Give a reason for recording this on someone's behalf.");
    email = clean(input.onBehalfOf, 200).toLowerCase(); onBehalf = { by: actorEmail, reason: why };
  }
  const assigned = (j.assignments || []).some((a) => a.active && a.email === email);
  if (!assigned) {
    await raise({ orgId, type: "UNAUTHORIZED_ATTEMPT", key: `${email}:${sid(j._id)}:${new Date().toISOString().slice(0, 13)}`, email, jobId: j._id, rule: "A job action was attempted by someone not assigned to the job.", evidence: { action: type, number: j.number } });
    return fail("This job isn't assigned to you.", 403, "NOT_ASSIGNED");
  }
  if (TERMINAL.includes(j.status)) return fail("This job is closed.", 409);
  const w = (j.workers || []).find((x) => x.email === email) || { email, state: "NOT_STARTED" };
  const settings = await getOpsSettings(orgId); const received = nowIso(); let now = received; let needsReview = false; let clientAt = null;
  // Offline queue (SOW 10.6): an action done without signal arrives later with the phone's "done at" time. The server
  // still decides: the phone's time is used only when it is plausible (not in the future, not older than 24 h, not
  // before this person's previous event on the job); otherwise the server time is used. Either way a late or
  // implausible queued action is flagged for a manager to review. Device time is never trusted blindly.
  if (input.queued && input.clientAt) {
    const t = new Date(input.clientAt); clientAt = Number.isNaN(t.getTime()) ? null : t.toISOString();
    const last = await c.find({ orgId: oid(orgId), kind: K.act, jobId: j._id, email }).sort({ at: -1 }).limit(1).toArray();
    const lastAt = last[0]?.at || null; const ageMin = clientAt ? minutesBetween(clientAt, received) : Infinity;
    const plausible = clientAt && new Date(clientAt) <= new Date(Date.now() + 2 * 60000) && ageMin <= 24 * 60 && (!lastAt || clientAt >= lastAt);
    if (plausible) now = clientAt; else needsReview = true;
    if (ageMin > 15) needsReview = true;
  }
  const reason = clean(input.reason, 60).toLowerCase(); const note = clean(input.note, 1000);
  const device = input.device ? { platform: clean(input.device.platform, 20), app: clean(input.device.app, 40), version: clean(input.device.version, 20) } : null;
  let verification = null;

  // state checks
  if (type === "ACK" && w.ack) return { event: null, alreadyAcknowledged: true };
  if (type === "START" || type === "RESUME") {
    if (w.state === "ACTIVE") return fail("You're already working on this job.", 409);
    if (type === "RESUME" && w.state !== "PAUSED") return fail("Only a paused job can be resumed.", 409);
    if (type === "START" && !["NOT_STARTED", "PAUSED"].includes(w.state)) return fail("This job was already submitted.", 409);
    if (!START_OK[j.type].includes(j.status)) return fail(j.status === "ON_HOLD" ? "A manager put this job on hold." : `The job can't be worked on while it is ${j.status.replace(/_/g, " ").toLowerCase()}.`, 409, "BAD_STATE");
    if (j.type === "RO" && (!j.approvedEstimateVersion || j.pendingChangeOrder)) return fail("The customer hasn't approved this work yet.", 409, "NOT_AUTHORISED");
    const elsewhere = await c.findOne({ orgId: oid(orgId), kind: K.job, _id: { $ne: j._id }, workers: { $elemMatch: { email, state: "ACTIVE" } } }, { projection: { number: 1 } });
    if (elsewhere) return fail(`Pause ${elsewhere.number} first: labour time can't overlap.`, 409, "OVERLAP");
    // verification (start only)
    if (type === "START") {
      if (input.siteCode) {
        const site = await c.findOne({ orgId: oid(orgId), kind: K.site, code: clean(input.siteCode, 40).toUpperCase(), active: { $ne: false } });
        if (!site || (site.warehouseId && sid(site.warehouseId) !== sid(j.warehouseId))) return fail("That site code doesn't match this job's site.", 409, "SITE_CODE");
        verification = { method: "site_code", siteId: sid(site._id) };
      } else if (validGeo(input.location) && settings.locationCapture !== "off") {
        const loc = { lat: Number(input.location.lat), lng: Number(input.location.lng), accuracy: Number(input.location.accuracy) || null };
        verification = { method: "location", location: loc };
        const target = j.siteGeo || (await c.findOne({ orgId: oid(orgId), kind: K.site, warehouseId: j.warehouseId, geo: { $exists: true }, active: { $ne: false } }))?.geo;
        if (validGeo(target)) { const dist = distanceM(target, loc); verification.distanceM = dist; if (dist > settings.siteRadiusMeters) await raise({ orgId, type: "OUTSIDE_RADIUS", key: `${email}:${sid(j._id)}:${idem}`, email, jobId: j._id, rule: `Job started about ${dist} m from the site (allowed ${settings.siteRadiusMeters} m).`, evidence: { distanceM: dist, accuracyM: loc.accuracy, number: j.number } }); }
      } else if (settings.locationCapture === "required") {
        verification = { method: "none" };
        await raise({ orgId, type: "NO_VERIFICATION", key: `${email}:${sid(j._id)}:${idem}`, email, jobId: j._id, rule: "Job started without location or site code; a supervisor should confirm.", evidence: { number: j.number } });
      }
    }
  }
  if (type === "PAUSE") { if (w.state !== "ACTIVE") return fail("Only an active job can be paused.", 409); if (!PAUSE_REASONS.includes(reason)) return fail(`Choose a pause reason: ${PAUSE_REASONS.join(", ")}.`); if (reason === "other" && note.length < 3) return fail("Add a short note for 'other'."); }
  if (type === "SUBMIT") {
    if (!["ACTIVE", "PAUSED"].includes(w.state)) return fail("Start the job before submitting it.", 409);
    const missing = (j.checklist || []).filter((x) => x.required && !x.done);
    const needsEvidence = (j.requireEvidence && !(j.evidence || []).length) || (j.checklist || []).some((x) => x.evidence && !(j.evidence || []).some((e) => e.checklistItemId === x.id));
    if (missing.length || needsEvidence) {
      await raise({ orgId, type: "INCOMPLETE_SUBMISSION", key: `${email}:${sid(j._id)}:${idem}`, email, jobId: j._id, rule: "Completion was attempted without the required checklist steps or evidence.", evidence: { missingSteps: missing.map((x) => x.text).slice(0, 10), evidenceMissing: needsEvidence, number: j.number }, severity: "info" });
      return fail(missing.length ? `Finish these checklist steps first: ${missing.map((x) => x.text).slice(0, 5).join("; ")}.` : "Add the required photo or document first.", 409, "INCOMPLETE");
    }
  }
  if (type === "FLAG" && !FLAG_KINDS.includes(reason)) return fail(`Choose what to flag: ${FLAG_KINDS.join(", ")}.`);

  // write the event (unique idempotency key), then the worker/job state
  const ev = { orgId: oid(orgId), kind: K.act, opsDoc: true, opsKey: `act:${idem}`, jobId: j._id, email, type, reason: reason || null, note: note || null, at: now, receivedAt: received, ...(input.queued ? { queued: true, clientAt, needsReview } : {}), by: actorEmail, onBehalf, verification, device, source: input.source === "mobile" ? "mobile" : "web" };
  try { const ins = await c.insertOne(ev); ev._id = ins.insertedId; }
  catch (e) { if (e?.code === 11000) { const prior = await c.findOne({ orgId: oid(orgId), opsKey: `act:${idem}` }); return { event: actView(prior), duplicate: true }; } throw e; }

  const events = await c.find({ orgId: oid(orgId), kind: K.act, jobId: j._id, email }).toArray();
  const labour = labourFromEvents(events)[email] || { minutes: 0 };
  const nextWorker = { ACK: w.state, START: "ACTIVE", RESUME: "ACTIVE", PAUSE: "PAUSED", SUBMIT: "SUBMITTED", FLAG: w.state }[type];
  const set = { "workers.$[w].state": nextWorker, "workers.$[w].since": now, "workers.$[w].minutes": labour.minutes, "workers.$[w].reason": type === "PAUSE" ? reason : null, lastActivityAt: now, updatedAt: now };
  if (type === "ACK") set["workers.$[w].ack"] = true;
  let nextStatus = j.status;
  if ((type === "START" || type === "RESUME") && j.status !== WORKING[j.type]) nextStatus = WORKING[j.type];
  if (type === "PAUSE" && reason === "parts") nextStatus = "AWAITING_PARTS";
  const lead = (j.assignments || []).find((a) => a.active && a.lead)?.email || email;
  if (type === "SUBMIT" && email === lead) nextStatus = j.type === "RO" ? "QUALITY_CHECK" : (j.requireInspection ? "AWAITING_INSPECTION" : "COMPLETED");
  if (nextStatus !== j.status) set.status = nextStatus;
  if (type === "SUBMIT" && email === lead) { set["completion.submittedBy"] = email; set["completion.submittedAt"] = now; }
  if (!(j.workers || []).some((x) => x.email === email)) await c.updateOne({ _id: j._id, "workers.email": { $ne: email } }, { $push: { workers: { email, state: "NOT_STARTED", ack: false, since: now, minutes: 0 } } });
  await c.updateOne({ _id: j._id }, { $set: set, ...(nextStatus !== j.status ? { $push: { history: { from: j.status, to: nextStatus, action: type.toLowerCase(), by: actorEmail, at: now, email } } } : {}) }, { arrayFilters: [{ "w.email": email }] });
  await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: `OPS_JOB_${type}`, previousState: w.state, newState: nextWorker, metadata: { email, reason: reason || null, onBehalf: onBehalf ? onBehalf.reason : null, verification: verification?.method || null } });

  if (needsReview) await raise({ orgId, type: "OFFLINE_ACTION", key: idem, email, jobId: j._id, rule: `A job action recorded without signal arrived ${clientAt ? `${minutesBetween(clientAt, received)} min late` : "without a usable time"}; check the time used.`, evidence: { action: type, phoneTime: clientAt, receivedAt: received, timeUsed: now, number: j.number }, severity: "info" });
  // side effects: flags and submissions reach the manager; labour variance is a review item.
  if (type === "FLAG") { await notifyMember({ orgId, email: j.managerEmail, title: `${j.number}: ${reason.replace("_", " ")} flagged`, body: note || "The technician flagged this job.", type: "ops_flag", sourceId: j._id, dedupeKey: `ops:flag:${idem}`, severity: reason === "safety" ? "critical" : "warning" }); if (reason === "safety") await raise({ orgId, type: "SAFETY_FLAG", key: idem, email, jobId: j._id, rule: "A technician raised a safety concern.", evidence: { note, number: j.number }, severity: "critical" }); }
  if (type === "SUBMIT" && email === lead) {
    await notifyMember({ orgId, email: j.managerEmail, title: `${j.number} ready for ${j.type === "RO" ? "quality check" : nextStatus === "COMPLETED" ? "closure" : "inspection"}`, body: "The technician submitted the job.", type: "ops_submitted", sourceId: j._id, dedupeKey: `ops:submit:${j._id}:${idem}` });
    if (j.estMinutes) { const all = labourFromEvents(await c.find({ orgId: oid(orgId), kind: K.act, jobId: j._id }).toArray()); const total = Object.values(all).reduce((s, x) => s + x.minutes, 0); const pct = Math.round(((total - j.estMinutes) / j.estMinutes) * 100);
      if (Math.abs(pct) >= settings.labourVariancePct) await raise({ orgId, type: "LABOUR_VARIANCE", key: `${sid(j._id)}`, jobId: j._id, rule: `Actual labour ${total} min vs estimate ${j.estMinutes} min (${pct > 0 ? "+" : ""}${pct}%).`, evidence: { actualMinutes: total, estMinutes: j.estMinutes, number: j.number }, severity: "info" }); }
  }
  return { event: actView(ev), state: nextWorker, status: nextStatus, labourMinutes: labour.minutes, needsReview };
}
const actView = (a) => (a ? { id: sid(a._id), type: a.type, email: a.email, at: a.at, reason: a.reason || null, note: a.note || null, verification: a.verification ? { method: a.verification.method, distanceM: a.verification.distanceM ?? null } : null } : null);

/** Labour correction: the technician (or a manager) asks; a DIFFERENT manager approves; applied as a CORRECTION event. */
export async function requestLabourCorrection({ orgId, membership, actorEmail, jobId, minutesDelta, reason }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r;
  const n = Number(minutesDelta); if (!(Number.isInteger(n) && n !== 0 && Math.abs(n) <= 24 * 60)) return fail("The correction must be whole minutes (up to a day).");
  const why = clean(reason, 500); if (why.length < 5) return fail("Explain the correction.");
  const c = await ccol(); const now = nowIso();
  const ins = await c.insertOne({ orgId: oid(orgId), kind: K.exc, opsDoc: true, type: "LABOUR_CORRECTION", email: actorEmail, jobId: r.job._id, rule: `Labour correction of ${n > 0 ? "+" : ""}${n} min requested.`, evidence: { minutesDelta: n, reason: why, number: r.job.number }, status: "OPEN", severity: "info", actions: [], createdAt: now, updatedAt: now, at: now });
  await audit({ orgId, actorEmail, recordType: "WORK_ORDER", recordId: r.job._id, action: "OPS_LABOUR_CORRECTION_REQUESTED", metadata: { minutesDelta: n } });
  return { requestId: sid(ins.insertedId) };
}

// ------------------------------------------------------------------ evidence (existing encrypted object storage)
const MAX_EVIDENCE = 4 * 1024 * 1024; // one request stays under the hosting limit
let storeImpl = null; // tests inject an in-memory store
export function __setEvidenceStore(fn) { storeImpl = fn; }
async function putObject({ orgId, key, buffer, contentType, actorEmail }) {
  if (storeImpl) return storeImpl.put({ orgId, key, buffer, contentType });
  const { putS3Object } = await import("../s3-compat/store.js"); const { ensureOwnerS3Passphrase } = await import("../s3-compat/credentials.js"); const { workspaceProviderOrder } = await import("../pinningProviders/index.js");
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  const order = workspaceProviderOrder(); let last;
  for (const providerName of order.length ? order : [undefined]) { try { return await putS3Object({ orgId: String(orgId), bucket: "ops-evidence", key, bodyBuffer: buffer, contentType, actorEmail, providerName }); } catch (e) { last = e; } }
  throw last;
}
async function getObject({ orgId, key, versionId }) {
  if (storeImpl) return storeImpl.get({ orgId, key });
  const { getS3ObjectBody } = await import("../s3-compat/store.js"); return getS3ObjectBody({ orgId: String(orgId), bucket: "ops-evidence", key, versionId });
}
export async function uploadEvidence({ orgId, membership, actorEmail, jobId, filename, buffer, caption, checklistItemId }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const r = await loadJob({ orgId, membership, jobId }); if (r.error) return r; const j = r.job;
  if (isTech(membership) && !(j.assigneeEmails || []).includes(actorEmail)) return fail("This job isn't assigned to you.", 403);
  if (TERMINAL.includes(j.status)) return fail("This job is closed.", 409);
  if (!buffer?.length) return fail("The file is empty."); if (buffer.length > MAX_EVIDENCE) return fail("Files must be 4 MB or smaller. Photos are resized by the app.", 413);
  const { checkFile, safeFilename, FILE_TYPES } = await import("../support/attachments.js"); const { scanBuffer, scanRefusal } = await import("../support/scanner.js");
  const name = safeFilename(filename); const problem = checkFile({ filename: name, buffer, settings: { attachments: { maxBytes: MAX_EVIDENCE } } }); if (problem) return fail(problem, 415);
  const scan = await scanBuffer({ filename: name, buffer, mode: "static" }); if (scan.status !== "CLEAN") return fail(scanRefusal(scan), 422, "SCAN");
  const id = newId(); const key = `${sid(j._id)}/${sid(id)}-${name}`; const contentType = FILE_TYPES[name.split(".").pop().toLowerCase()] || "application/octet-stream";
  const stored = await putObject({ orgId, key, buffer, contentType, actorEmail });
  const c = await ccol(); const at = nowIso();
  await c.insertOne({ _id: id, orgId: oid(orgId), kind: K.file, opsDoc: true, jobId: j._id, filename: name, size: buffer.length, contentType, storage: { key, versionId: stored?.versionId || null }, by: actorEmail, at, createdAt: at });
  const item = (j.checklist || []).find((x) => x.id === checklistItemId);
  const ev = { id: sid(id), fileId: id, name, size: buffer.length, caption: clean(caption, 200) || null, checklistItemId: item ? item.id : null, by: actorEmail, at };
  await c.updateOne({ _id: j._id }, { $push: { evidence: ev }, $set: { updatedAt: at, lastActivityAt: at } });
  await audit({ orgId, actorEmail, recordType: j.type === "RO" ? "REPAIR_ORDER" : "WORK_ORDER", recordId: j._id, action: "OPS_EVIDENCE_ADDED", metadata: { name, size: buffer.length } });
  return { evidence: { ...ev, fileId: sid(id) } };
}
export async function downloadEvidence({ orgId, membership, actorEmail, fileId }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const c = await ccol(); const f = await c.findOne({ _id: oid(fileId), orgId: oid(orgId), kind: K.file }); if (!f) return fail("File not found.", 404);
  const r = await loadJob({ orgId, membership, jobId: f.jobId }); if (r.error) return r;
  const obj = await getObject({ orgId, key: f.storage.key, versionId: f.storage.versionId || undefined }); if (!obj) return fail("File not available.", 404);
  await audit({ orgId, actorEmail, recordType: "WORK_ORDER", recordId: f.jobId, action: "OPS_EVIDENCE_ACCESSED", metadata: { fileId: sid(f._id) } });
  return { filename: f.filename, contentType: f.contentType, buffer: obj.buffer };
}

// ------------------------------------------------------------------ the technician's day (mobile home)
export async function myDay({ orgId, membership }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const c = await ccol(); const email = membership.email; const now = new Date();
  const status = await myStatus({ orgId, membership });
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0); const dayEnd = new Date(dayStart.getTime() + 86400000);
  const shifts = await c.find({ orgId: oid(orgId), kind: WK.shift, email, status: { $in: ["PUBLISHED", "ACKNOWLEDGED"] }, start: { $lt: dayEnd.toISOString() }, end: { $gt: dayStart.toISOString() } }).sort({ start: 1 }).toArray();
  const jobs = await c.find({ orgId: oid(orgId), kind: K.job, assigneeEmails: email, status: { $nin: ["CLOSED", "CANCELLED", "INVOICED"] } }).sort({ plannedStart: 1 }).limit(100).toArray();
  const views = jobs.map((j) => ({ ...viewFor(membership, j), myState: (j.workers || []).find((w) => w.email === email)?.state || "NOT_STARTED", myAck: !!(j.workers || []).find((w) => w.email === email)?.ack, mySlot: (j.assignments || []).find((a) => a.active && a.email === email) || null }));
  const current = views.find((v) => v.myState === "ACTIVE") || null;
  const today = views.filter((v) => v.mySlot?.start && new Date(v.mySlot.start) < dayEnd);
  const upcoming = views.filter((v) => !v.mySlot?.start || new Date(v.mySlot.start) >= dayEnd);
  const needsAction = views.filter((v) => !v.myAck || v.status === "ASSIGNED" && v.myState === "NOT_STARTED" || ["inspect_fail", "qc_fail"].includes((v.history || []).at(-1)?.action));
  const { listNotificationsFor } = await import("../notifications.js");
  const notes = await listNotificationsFor({ scope: "org", orgId: sid(orgId), email, unreadOnly: true, limit: 20 }).catch(() => []);
  return { role: opsRoleOf(membership), attendance: status, shifts: shifts.map((s) => ({ id: sid(s._id), start: s.start, end: s.end, locationId: sid(s.locationId), role: s.role || null, status: s.status })), current, today, upcoming, needsAction: needsAction.map((v) => v.id), notifications: (notes?.notifications || notes || []).filter((n) => n.sourceModule === "manage-orders").slice(0, 20) };
}

// ------------------------------------------------------------------ exceptions
export const excView = (e) => ({ id: sid(e._id), type: e.type, email: e.email, jobId: sid(e.jobId), rule: e.rule, evidence: e.evidence, status: e.status, severity: e.severity, actions: e.actions || [], createdAt: e.createdAt });
export async function listExceptions({ orgId, membership, status = "OPEN" }) {
  const d = await opsAccess({ orgId, membership, need: "exceptions" }); if (d) return d;
  const c = await ccol(); const f = { orgId: oid(orgId), kind: K.exc, ...(status === "ALL" ? {} : { status: { $in: String(status).split(",") } }) };
  return { exceptions: (await c.find(f).sort({ createdAt: -1 }).limit(200).toArray()).map(excView) };
}
/** action: acknowledge | request_explanation | approve_correction | reassign | escalate | dismiss | resolve. */
export async function resolveException({ orgId, membership, actorEmail, id, action, reason }) {
  const d = await opsAccess({ orgId, membership, need: "exceptions" }); if (d) return d;
  if (!["acknowledge", "request_explanation", "approve_correction", "reject_correction", "reassign", "escalate", "dismiss", "resolve"].includes(action)) return fail("Unknown action.");
  const why = clean(reason, 500); if (["dismiss", "reject_correction", "escalate", "request_explanation"].includes(action) && why.length < 3) return fail("Give a reason.");
  const c = await ccol(); const e = await c.findOne({ _id: oid(id), orgId: oid(orgId), kind: K.exc }); if (!e) return fail("Item not found.", 404);
  if (["RESOLVED", "DISMISSED"].includes(e.status)) return fail("This item is already closed.", 409);
  const now = nowIso(); let status = { acknowledge: "ACKNOWLEDGED", request_explanation: "EXPLANATION_REQUESTED", escalate: "ESCALATED", dismiss: "DISMISSED", resolve: "RESOLVED", reassign: "RESOLVED", approve_correction: "RESOLVED", reject_correction: "RESOLVED" }[action];
  if (action.endsWith("_correction")) {
    if (e.type !== "LABOUR_CORRECTION") return fail("This item isn't a correction request.");
    if (e.email === actorEmail) return fail("A different manager must decide your own correction.", 403);
    if (action === "approve_correction") {
      const idem = `corr_${sid(e._id)}`;
      try { await c.insertOne({ orgId: oid(orgId), kind: K.act, opsDoc: true, opsKey: `act:${idem}`, jobId: e.jobId, email: e.email, type: "CORRECTION", minutesDelta: e.evidence.minutesDelta, reason: e.evidence.reason, correctionOf: e._id, approvedBy: actorEmail, at: now, by: actorEmail, source: "manager" }); } catch (err) { if (err?.code !== 11000) throw err; }
      const events = await c.find({ orgId: oid(orgId), kind: K.act, jobId: e.jobId, email: e.email }).toArray();
      await c.updateOne({ _id: e.jobId }, { $set: { "workers.$[w].minutes": (labourFromEvents(events)[e.email] || { minutes: 0 }).minutes } }, { arrayFilters: [{ "w.email": e.email }] });
    }
  }
  await c.updateOne({ _id: e._id }, { $set: { status, updatedAt: now }, $push: { actions: { action, by: actorEmail, at: now, reason: why || null } } });
  await audit({ orgId, actorEmail, recordType: "OPS_EXCEPTION", recordId: e._id, action: `OPS_EXCEPTION_${action.toUpperCase()}`, previousState: e.status, newState: status, metadata: { type: e.type, reason: why || null } });
  if (action === "request_explanation" && e.email) await notifyMember({ orgId, email: e.email, title: "Your manager asked for an explanation", body: "Open Manage Orders to reply.", type: "ops_explain", sourceId: e._id, dedupeKey: `ops:explain:${e._id}` });
  return { exception: excView(await c.findOne({ _id: e._id })) };
}
/** The person the item is about can reply (an explanation note on the item). */
export async function explainException({ orgId, membership, actorEmail, id, text }) {
  const d = await opsAccess({ orgId, membership }); if (d) return d;
  const c = await ccol(); const e = await c.findOne({ _id: oid(id), orgId: oid(orgId), kind: K.exc }); if (!e || e.email !== actorEmail) return fail("Item not found.", 404);
  const t = clean(text, 1000); if (t.length < 3) return fail("Write your explanation.");
  await c.updateOne({ _id: e._id }, { $push: { actions: { action: "explanation", by: actorEmail, at: nowIso(), reason: t } }, $set: { updatedAt: nowIso() } });
  return { ok: true };
}
/** Pattern scan (cron + on demand). Creates de-duplicated review items; never acts on pay or discipline. */
export async function scanExceptions(orgId, now = new Date()) {
  if (!(await opsEntitled(orgId))) return { skipped: true };
  const s = await getOpsSettings(orgId); const c = await ccol(); let raised = 0; const day = now.toISOString().slice(0, 10);
  // 1. clocked in but no job started after the threshold
  const since = new Date(now.getTime() - 24 * 3600000).toISOString();
  const punches = await c.find({ orgId: oid(orgId), kind: WK.punch, at: { $gte: since }, voided: { $ne: true } }).sort({ at: 1 }).toArray();
  const last = new Map(); for (const p of punches) last.set(p.email, p);
  const { orgMembers } = await getOrgCollections();
  const techs = new Set((await orgMembers.find({ orgId: oid(orgId), status: "active", opsRole: "technician" }, { projection: { email: 1 } }).toArray()).map((m) => m.email));
  for (const [email, p] of last) {
    if (!techs.has(email) || !["CLOCK_IN", "BREAK_END"].includes(p.type)) continue;
    const clockedFor = minutesBetween(p.at, now); if (clockedFor < s.noJobStartMinutes) continue;
    const active = await c.findOne({ orgId: oid(orgId), kind: K.job, workers: { $elemMatch: { email, state: "ACTIVE" } } }, { projection: { _id: 1 } });
    const startedSince = await c.findOne({ orgId: oid(orgId), kind: K.act, email, type: { $in: ["START", "RESUME"] }, at: { $gte: p.at } }, { projection: { _id: 1 } });
    if (!active && !startedSince && await raise({ orgId, type: "NO_JOB_START", key: `${email}:${day}:${p.at}`, email, rule: `Clocked in for ${clockedFor} min with no job started (threshold ${s.noJobStartMinutes} min).`, evidence: { clockedInAt: p.at } })) raised++;
  }
  // 2. scheduled but not started; 3. paused too long
  const open = await c.find({ orgId: oid(orgId), kind: K.job, status: { $in: ["ASSIGNED", "SCHEDULED", "IN_PROGRESS", "IN_REPAIR", "AWAITING_PARTS"] } }).limit(2000).toArray();
  for (const j of open) for (const w of j.workers || []) {
    const a = (j.assignments || []).find((x) => x.active && x.email === w.email); if (!a) continue;
    if (w.state === "NOT_STARTED" && a.start && minutesBetween(a.start, now) >= s.notAcknowledgedMinutes && new Date(a.start) < now && await raise({ orgId, type: "NOT_STARTED", key: `${sid(j._id)}:${w.email}:${a.start}`, email: w.email, jobId: j._id, rule: `${j.number} was due to start ${minutesBetween(a.start, now)} min ago and hasn't been started.`, evidence: { scheduledStart: a.start, acknowledged: !!w.ack, number: j.number } })) raised++;
    if (w.state === "PAUSED" && w.reason !== "end_of_shift" && minutesBetween(w.since, now) >= s.pausedTooLongMinutes && await raise({ orgId, type: "PAUSED_TOO_LONG", key: `${sid(j._id)}:${w.email}:${w.since}`, email: w.email, jobId: j._id, rule: `${j.number} paused for ${minutesBetween(w.since, now)} min (${w.reason || "no reason"}).`, evidence: { pausedSince: w.since, reason: w.reason || null, number: j.number } })) raised++;
  }
  // 4. many manual attendance corrections this week
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const corr = await c.aggregate([{ $match: { orgId: oid(orgId), kind: WK.corr, createdAt: { $gte: weekAgo } } }, { $group: { _id: "$email", n: { $sum: 1 } } }]).toArray();
  for (const x of corr) if (x._id && x.n > s.manualCorrectionsPerWeek && await raise({ orgId, type: "MANY_CORRECTIONS", key: `${x._id}:${weekAgo.slice(0, 10)}`, email: x._id, rule: `${x.n} attendance corrections in 7 days (threshold ${s.manualCorrectionsPerWeek}).`, evidence: { count: x.n }, severity: "info" })) raised++;
  return { raised };
}
export async function scanAllExceptions(now = new Date()) {
  const { orgs } = await getOrgCollections();
  const list = await orgs.find({ $or: [{ "features.FEATURE_MANAGE_ORDERS": true }, { plan: { $in: ["business", "enterprise"] } }] }, { projection: { _id: 1 } }).limit(5000).toArray();
  let raised = 0, orgsScanned = 0;
  for (const o of list) { try { const r = await scanExceptions(sid(o._id), now); if (!r.skipped) { orgsScanned++; raised += r.raised; } } catch (e) { console.error("ops scan failed for an org:", e?.message); } }
  return { orgsScanned, raised };
}

// ------------------------------------------------------------------ site codes (QR / typed)
export async function saveSite({ orgId, membership, actorEmail, input = {} }) {
  const d = await opsAccess({ orgId, membership, need: "settings" }); if (d) return d; await ensureOpsIndexes();
  const name = clean(input.name, 80); if (!name) return fail("Name the site.");
  const code = (clean(input.code, 40) || Math.random().toString(36).slice(2, 8)).toUpperCase().replace(/[^A-Z0-9-]/g, ""); if (code.length < 4) return fail("A site code needs at least 4 letters or numbers.");
  const geo = validGeo(input.geo) ? { lat: Number(input.geo.lat), lng: Number(input.geo.lng) } : null;
  const c = await ccol(); const doc = { orgId: oid(orgId), kind: K.site, opsDoc: true, opsKey: `site:${code}`, code, name, warehouseId: oid(input.warehouseId), geo, active: true, createdBy: actorEmail, createdAt: nowIso() };
  try { const r = await c.insertOne(doc); doc._id = r.insertedId; } catch (e) { if (e?.code === 11000) return fail("That site code is already used.", 409); throw e; }
  await audit({ orgId, actorEmail, recordType: "OPS_SITE", recordId: doc._id, action: "OPS_SITE_CREATED", metadata: { code } });
  return { site: { id: sid(doc._id), code, name, warehouseId: sid(doc.warehouseId), geo } };
}
export async function listSites({ orgId, membership }) {
  const d = await opsAccess({ orgId, membership, need: "view_all" }); if (d) return d;
  const c = await ccol(); return { sites: (await c.find({ orgId: oid(orgId), kind: K.site, active: { $ne: false }, ...scopeFilter(membership, "warehouseId") }).toArray()).map((s) => ({ id: sid(s._id), code: s.code, name: s.name, warehouseId: sid(s.warehouseId), geo: s.geo })) };
}
