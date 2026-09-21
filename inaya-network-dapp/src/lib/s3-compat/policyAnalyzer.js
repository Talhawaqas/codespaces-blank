// src/lib/s3-compat/policyAnalyzer.js
//
// AWS S3 Feature Expansion SOW, Phase 9 -- Storage Access Policy Analyzer.
// Read-only by construction: this file has no import of anything that
// writes to s3_credentials (issueS3Credential/revokeS3Credential live in
// credentials.js and are never called from here). Every finding is
// computed from a real, stored field on the credential -- never a
// fabricated risk score. "Unused credential" detection is explicitly NOT
// implemented: s3_credentials has no lastUsedAt field (confirmed absent
// by the Phase 0 audit), so claiming to detect one would be exactly the
// "invented signal" this SOW's own §9 forbids -- the finding type exists
// in the output shape as `unusedCredentials: null` (not `[]`) so a caller
// can tell "not computed" apart from "computed, found none."

import { listS3Credentials } from "./credentials.js";

function findingsFor(credential) {
  const findings = [];
  const scope = credential.scope;

  if (!credential.active) return findings; // revoked credentials aren't a live risk

  if (!scope) {
    findings.push({ type: "UNRESTRICTED_CREDENTIAL", severity: "HIGH", detail: "This credential has no scope at all -- full owner-level access to every bucket and operation." });
    return findings; // the rest of the checks are about a scope this credential doesn't have
  }
  if (!scope.expiresAt) {
    findings.push({ type: "NO_EXPIRY", severity: "MEDIUM", detail: "This credential never expires." });
  } else if (new Date(scope.expiresAt).getTime() <= Date.now()) {
    findings.push({ type: "EXPIRED_STILL_PRESENT", severity: "LOW", detail: `Expired ${scope.expiresAt} but has not been revoked -- checkScope() already rejects requests from it, this is a housekeeping finding, not an active exposure.` });
  }
  if (!scope.bucket && scope.operations?.includes("DELETE")) {
    findings.push({ type: "BROAD_DESTRUCTIVE_SCOPE", severity: "HIGH", detail: "This credential can DELETE in any bucket -- no bucket restriction on a destructive operation." });
  }
  if (!scope.bucket && !scope.operations) {
    findings.push({ type: "BROAD_UNSCOPED", severity: "MEDIUM", detail: "This credential has no bucket restriction and no operation restriction." });
  }
  return findings;
}

export async function analyzeS3CredentialPolicies(owner) {
  const credentials = await listS3Credentials(owner);
  const perCredential = credentials.map((c) => ({
    accessKeyId: c.accessKeyId,
    label: c.label,
    active: c.active,
    scope: c.scope,
    createdAt: c.createdAt,
    findings: findingsFor(c),
  }));

  return {
    generatedAt: new Date().toISOString(),
    credentialCount: credentials.length,
    activeCredentialCount: credentials.filter((c) => c.active).length,
    findingCount: perCredential.reduce((sum, c) => sum + c.findings.length, 0),
    unusedCredentials: null, // see module header -- genuinely not computable today
    credentials: perCredential,
  };
}
