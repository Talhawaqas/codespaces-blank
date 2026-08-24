// src/lib/hackathonReports.js
//
// Backend for the Hackathon's bug-report submissions. Separate from
// src/lib/hackathon.js (which is the prize pool/winners side) because this
// has its own signature scheme and its own collection -- keeping them apart
// avoids one file trying to be both "prize config" and "user-submitted
// content store."
//
// Signature verification mirrors src/lib/metadata-auth.js's
// verifyMetadataAuth() shape exactly (rebuild the canonical message,
// recover the signer, compare, fail closed) but with its own message
// header -- reusing verifyMetadataAuth directly would sign every report
// with the literal string "Inaya Metadata Action", which is wrong for what
// this actually is.

import { ethers } from "ethers";
import { isValidLayer, isValidSeverity } from "./hackathon";

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // 5 minutes, same window as metadata-auth.js

/** Recomputes the bug-report canonical message and confirms the signature recovers to the
 *  claimed wallet address. Throws (not returns false) so every caller fails closed. */
export function verifyHackathonReportAuth({ walletAddress, title, layer, severity, message, signature, timestamp }) {
  if (!walletAddress || !message || !signature || typeof timestamp !== "number") {
    throw new Error("Missing auth fields — walletAddress, message, signature, and timestamp are all required.");
  }
  if (Date.now() - timestamp > MAX_SIGNATURE_AGE_MS) {
    throw new Error("Signature expired — please retry.");
  }

  const expectedMessage = [
    "Inaya Hackathon Bug Report",
    `title: ${title}`,
    `layer: ${layer}`,
    `severity: ${severity}`,
    `timestamp: ${timestamp}`,
  ].join("\n");

  if (message !== expectedMessage) {
    throw new Error("Signed message doesn't match the request fields — possible tampering.");
  }

  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("Signature does not match the claimed wallet address.");
  }
}

export async function ensureHackathonReportIndexes(db) {
  await db.collection("hackathon_bug_reports").createIndex({ walletAddress: 1, createdAt: -1 });
}

export async function createBugReport(db, { title, layer, severity, description, stepsToReproduce, evidenceUrl, walletAddress }) {
  if (!title || typeof title !== "string" || !title.trim()) {
    throw new Error("title is required.");
  }
  if (!isValidLayer(layer)) {
    throw new Error(`Invalid layer "${layer}".`);
  }
  if (!isValidSeverity(severity)) {
    throw new Error(`Invalid severity "${severity}".`);
  }
  if (!description || typeof description !== "string" || !description.trim()) {
    throw new Error("description is required.");
  }

  const doc = {
    title: title.trim(),
    layer,
    severity,
    description: description.trim(),
    stepsToReproduce: stepsToReproduce ? String(stepsToReproduce).trim() : null,
    evidenceUrl: evidenceUrl ? String(evidenceUrl).trim() : null,
    walletAddress: walletAddress.toLowerCase(),
    status: "submitted",
    finalSeverity: null,
    triageNotes: null,
    createdAt: new Date().toISOString(),
  };
  const result = await db.collection("hackathon_bug_reports").insertOne(doc);
  return { id: result.insertedId.toString(), ...doc };
}

export async function listBugReports(db) {
  const docs = await db.collection("hackathon_bug_reports").find({}).sort({ createdAt: -1 }).toArray();
  return docs.map((d) => ({ ...d, id: d._id.toString(), _id: undefined }));
}

export async function listMyBugReports(db, walletAddress) {
  const docs = await db
    .collection("hackathon_bug_reports")
    .find({ walletAddress: walletAddress.toLowerCase() })
    .sort({ createdAt: -1 })
    .toArray();
  return docs.map((d) => ({ ...d, id: d._id.toString(), _id: undefined }));
}
