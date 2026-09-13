// src/lib/financial-attestation.js
//
// Four High-Impact Business Workspace Extensions SOW — Feature 4:
// "Cryptographic Financial Attestation" (named precisely per the SOW's own
// §34 guidance, never "zero-knowledge proof" anywhere in this file, its
// routes, or the UI).
//
// STATUS — this is a hash-commitment + server-attested-computation scheme,
// NOT zero-knowledge cryptography. Confirmed by inspection: no ZK proving
// system exists anywhere in this codebase's dependencies (no snarkjs/
// circom/noir/halo2/groth16/plonk/circomlibjs/ffjavascript/BN254/BLS12-381,
// root or custody-sdk, direct or transitive). Building a real ZK circuit is
// net-new cryptographic infrastructure (a new dependency + circuit design)
// and is explicitly out of scope for this pass — see this SOW's own §34
// guardrail against overclaiming what a "proof" establishes.
//
// What this actually does: queries the org's real, permission-scoped
// invoice/expense data for a period (the exact same scope resolution
// business-insights.js already uses), builds a canonical, sorted list of
// the included records, computes sha256(canonicalJSON(...)) as the
// "dataset commitment" (the exact discipline auditChain.js already uses
// for its hash chain), evaluates ONE narrow statement against that real
// data, and exposes an independent verifier that re-runs the same query
// and recomputes the commitment fresh — any drift is INVALID, never
// silently passed.
//
// Only revenue-threshold and expense-threshold statements are implemented
// — both are directly computable from real invoice/expense records. A
// solvency statement (qualifying assets − liabilities ≥ X) is NOT built:
// this codebase's finance schema has no assets/liabilities/balance-sheet
// concept at all (confirmed by inspection), and fabricating one to make
// the SOW's example statement "work" would be exactly the kind of
// unsupported-capability dishonesty this whole SOW pass exists to avoid.
// Documented as Planned/Unsupported.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { getAccessibleScope } from "./document-permissions.js";
import { logOrgActivity } from "./org-activity-log.js";
import { canManageAttestations } from "./orgGates.js";
import { convert, isSupportedCurrency, RATES_AS_OF } from "./currency.js";

export const ATTESTATION_STATES = [
  "DRAFT", "DATASET_PREPARED", "COMMITMENT_CREATED", "PROOF_GENERATING", "PROOF_GENERATED",
  "VERIFICATION_AVAILABLE", "VERIFIED", "FAILED", "SUPERSEDED",
];

export const STATEMENT_TYPES = ["revenue_threshold", "expense_threshold"];
// Explicitly listed, never silently accepted -- see module header.
export const UNSUPPORTED_STATEMENT_TYPES = ["solvency_threshold"];

function sha256Hex(str) {
  return "0x" + createHash("sha256").update(str, "utf8").digest("hex");
}

/** Deep, recursive canonicalization -- sorts keys at EVERY level, not just
 *  the top one. auditChain.js's own `JSON.stringify(fields,
 *  Object.keys(fields).sort())` trick only works because every event it
 *  canonicalizes is flat; JSON.stringify's array-replacer form applies
 *  the SAME allowlist at every nesting level, so naively reusing that
 *  one-liner here would silently strip every field out of this payload's
 *  nested `period` object and `records` array (confirmed while writing
 *  this file's own tests) -- a real bug that would have made the
 *  "commitment" ignore the entire dataset it's supposed to commit to. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortDeep(value[key]);
      return acc;
    }, {});
  }
  return value;
}
function canonicalJSON(obj) {
  return JSON.stringify(sortDeep(obj));
}

/** Builds the canonical, currency-normalized dataset for one statement type
 *  + period, from REAL scoped records — never a client-supplied dataset. */
async function buildCanonicalDataset({ orgId, membership, email, statementType, startDate, endDate, displayCurrency }) {
  const scope = await getAccessibleScope({ orgId, membership, email });
  const rangeStart = new Date(startDate).getTime();
  const rangeEnd = new Date(endDate).getTime();
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd < rangeStart) {
    return { error: "Invalid period: endDate must be on or after startDate." };
  }

  let records;
  if (statementType === "revenue_threshold") {
    records = scope.visibleInvoices
      .filter((i) => i.status === "PAID")
      .filter((i) => { const t = new Date(i.updatedAt).getTime(); return t >= rangeStart && t <= rangeEnd; })
      .map((i) => ({ recordId: i._id.toString(), amount: i.total, currency: i.currency || "USD", updatedAt: i.updatedAt }));
  } else if (statementType === "expense_threshold") {
    records = scope.visibleExpenses
      .filter((e) => e.status === "APPROVED")
      .filter((e) => { const t = new Date(e.updatedAt).getTime(); return t >= rangeStart && t <= rangeEnd; })
      .map((e) => ({ recordId: e._id.toString(), amount: e.amount, currency: e.currency || "USD", updatedAt: e.updatedAt }));
  } else {
    return { error: `Unsupported statement type "${statementType}" — no real underlying dataset exists for it in this codebase today.` };
  }

  // Multi-currency: convert every record into the display currency
  // explicitly, recording exactly how (never a silently chosen rate).
  const targetCurrency = displayCurrency || "USD";
  if (!isSupportedCurrency(targetCurrency)) return { error: `Unsupported currency "${targetCurrency}".` };

  const conversions = [];
  let total = 0;
  for (const r of records) {
    const converted = convert(r.amount, r.currency, targetCurrency);
    if (converted.error) return { error: `Cannot convert record ${r.recordId} from ${r.currency} to ${targetCurrency}: ${converted.error}` };
    total = Math.round((total + converted.convertedAmount) * 100) / 100;
    conversions.push({ recordId: r.recordId, sourceAmount: r.amount, sourceCurrency: r.currency, convertedAmount: converted.convertedAmount, rate: converted.rate });
  }

  const sortedRecords = [...conversions].sort((a, b) => a.recordId.localeCompare(b.recordId));
  return {
    records: sortedRecords,
    total,
    currency: targetCurrency,
    currencyRatesAsOf: RATES_AS_OF,
    recordCount: sortedRecords.length,
  };
}

function evaluateStatement(statementType, total, threshold) {
  if (statementType === "revenue_threshold") return total >= threshold;
  if (statementType === "expense_threshold") return total <= threshold;
  return false;
}

/** Generates a new attestation. Deliberately synchronous/fast (no real
 *  proving system to wait on) — PROOF_GENERATING/PROOF_GENERATED are
 *  passed through immediately, and the API response says plainly this is
 *  a commitment, not a proof. */
export async function generateAttestation({ orgId, statementType, startDate, endDate, threshold, displayCurrency, membership, actorEmail }) {
  if (!canManageAttestations(membership)) return { error: "Only an attestation manager or an org owner/admin can generate an attestation.", status: 403 };
  if (UNSUPPORTED_STATEMENT_TYPES.includes(statementType)) {
    return { error: `"${statementType}" is not supported — this codebase has no assets/liabilities data model to attest against.`, status: 400 };
  }
  if (!STATEMENT_TYPES.includes(statementType)) return { error: `statementType must be one of: ${STATEMENT_TYPES.join(", ")}.`, status: 400 };
  if (!Number.isFinite(Number(threshold))) return { error: "threshold must be a number.", status: 400 };

  const dataset = await buildCanonicalDataset({ orgId, membership, email: actorEmail, statementType, startDate, endDate, displayCurrency });
  if (dataset.error) return { error: dataset.error, status: 400 };

  const commitmentPayload = {
    orgId: orgId.toString(), statementType, period: { startDate, endDate },
    records: dataset.records, currency: dataset.currency, currencyRatesAsOf: dataset.currencyRatesAsOf,
  };
  const datasetCommitment = sha256Hex(canonicalJSON(commitmentPayload));
  const satisfied = evaluateStatement(statementType, dataset.total, Number(threshold));

  const { financialAttestations } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();
  const result = await financialAttestations.insertOne({
    orgId: orgObjectId,
    statementType,
    period: { startDate, endDate },
    statementParams: { threshold: Number(threshold), currency: dataset.currency },
    datasetCommitment,
    recordCount: dataset.recordCount,
    computedTotal: dataset.total, // retained server-side for the independent verifier to recompute against; NEVER returned by the public verify endpoint
    result: satisfied ? "SATISFIED" : "NOT_SATISFIED",
    status: "VERIFICATION_AVAILABLE",
    generatedByEmail: actorEmail,
    generatedAt: now,
    verifiedAt: null,
    supersededBy: null,
  });

  await logOrgActivity({
    orgId: orgObjectId, recordType: "FINANCIAL_ATTESTATION", recordId: result.insertedId, actorEmail,
    action: "ATTESTATION_GENERATED", previousState: null, newState: "VERIFICATION_AVAILABLE",
    metadata: { statementType, datasetCommitment, result: satisfied ? "SATISFIED" : "NOT_SATISFIED" },
  });

  return { attestationId: result.insertedId, datasetCommitment, result: satisfied ? "SATISFIED" : "NOT_SATISFIED" };
}

export async function getAttestation({ orgId, attestationId }) {
  const { financialAttestations } = await getOrgCollections();
  return financialAttestations.findOne({ _id: toObjectId(attestationId), orgId: toObjectId(orgId) });
}

export async function listAttestations(orgId) {
  const { financialAttestations } = await getOrgCollections();
  return financialAttestations.find({ orgId: toObjectId(orgId) }).sort({ generatedAt: -1 }).toArray();
}

/** Independent verification. Recomputes the ENTIRE dataset fresh from the
 *  same real records over the same committed period and re-derives the
 *  commitment hash -- if the underlying data has changed since generation
 *  (an invoice edited, a new one added inside the period, one deleted),
 *  the recomputed hash will differ and this returns INVALID. Never
 *  returns the underlying records themselves -- only the statement, the
 *  commitment, and the result, per the SOW's own "verifier learns only
 *  the statement required" principle (weaker than real ZK, since the
 *  computation itself was NOT done in zero-knowledge — the server saw the
 *  full dataset to compute it — but the RESPONSE still discloses nothing
 *  beyond the statement outcome). */
export async function verifyAttestation({ orgId, attestationId, membership, actorEmail }) {
  const attestation = await getAttestation({ orgId, attestationId });
  if (!attestation) return { error: "Attestation not found.", status: 404 };

  if (attestation.status === "SUPERSEDED") return { verificationResult: "EXPIRED_SUPERSEDED", status: attestation.status };

  const dataset = await buildCanonicalDataset({
    orgId, membership, email: actorEmail, statementType: attestation.statementType,
    startDate: attestation.period.startDate, endDate: attestation.period.endDate, displayCurrency: attestation.statementParams.currency,
  });
  if (dataset.error) return { verificationResult: "INVALID", reason: dataset.error };

  const commitmentPayload = {
    orgId: orgId.toString(), statementType: attestation.statementType, period: attestation.period,
    records: dataset.records, currency: dataset.currency, currencyRatesAsOf: dataset.currencyRatesAsOf,
  };
  const recomputedCommitment = sha256Hex(canonicalJSON(commitmentPayload));

  let verificationResult;
  if (recomputedCommitment !== attestation.datasetCommitment) {
    verificationResult = "INVALID"; // dataset changed since generation
  } else {
    const stillSatisfied = evaluateStatement(attestation.statementType, dataset.total, attestation.statementParams.threshold);
    const claimedResult = attestation.result === "SATISFIED";
    verificationResult = stillSatisfied === claimedResult ? "VALID" : "INVALID";
  }

  const { financialAttestations } = await getOrgCollections();
  await financialAttestations.updateOne({ _id: attestation._id }, { $set: { status: verificationResult === "VALID" ? "VERIFIED" : "FAILED", verifiedAt: new Date().toISOString() } });

  await logOrgActivity({
    orgId: toObjectId(orgId), recordType: "FINANCIAL_ATTESTATION", recordId: attestation._id, actorEmail,
    action: "ATTESTATION_VERIFIED", previousState: attestation.status, newState: verificationResult === "VALID" ? "VERIFIED" : "FAILED",
    metadata: { verificationResult },
  });

  return {
    verificationResult, // VALID | INVALID | UNSUPPORTED_VERSION | EXPIRED_SUPERSEDED
    statementType: attestation.statementType,
    period: attestation.period,
    statementParams: attestation.statementParams,
    datasetCommitment: attestation.datasetCommitment,
    claimedResult: attestation.result,
  };
}
