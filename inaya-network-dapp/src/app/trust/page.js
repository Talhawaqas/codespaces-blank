"use client";

// app/trust/page.js
//
// Institutional Trust Infrastructure SOW, Phase 1 — the Inaya Trust
// Center. Public, unauthenticated (no wallet, no login), same convention
// as app/security/page.js. Built entirely from real, already-shipped
// facts and one new interactive piece: a client-side evidence-chain
// verifier that recomputes auditChain.js's own hash formula in the
// visitor's browser via Web Crypto, so verification never has to trust
// this server's own "Verified" claim.
//
// HONESTY: no fabricated incident history, uptime figures, or
// certification claims anywhere on this page — see the inline copy
// itself for how each section is worded. Where Inaya has no public
// incident log or certification to point to, this page says that
// plainly rather than implying otherwise.

import { useState } from "react";

// Mirrors src/lib/auditChain.js's computeEntryHash/canonicalize EXACTLY —
// same field set, same sorted-key JSON.stringify, same sha256(prevHash +
// canonicalFields) formula — recomputed here via Web Crypto instead of
// node:crypto so this runs entirely in the visitor's own browser.
const GENESIS_HASH = "0".repeat(64);

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalize(fields) {
  return JSON.stringify(fields, Object.keys(fields).sort());
}

async function computeEntryHash(prevHash, canonicalFields) {
  return sha256Hex(prevHash + canonicalFields);
}

/** entries: the "entries" array from an exported evidence package (either
 *  api/orgs/audit/export or evidence.js's exportEvidencePackage — same
 *  shape). Returns { valid, count } or { valid:false, count, brokenAtSeq, reason }. */
async function verifyEvidencePackage(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { valid: false, count: 0, reason: "No entries found in the pasted JSON." };

  let expectedPrevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, reason: `expected seq ${expectedSeq}, found ${entry.seq} (a gap or reorder)` };
    }
    if (entry.prevHash !== expectedPrevHash) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, reason: "prevHash does not match the prior entry's hash" };
    }
    // The export route serializes a null recordId as "" — recompute
    // against the TRUE original field value (null) so a legitimate
    // no-recordId entry (currently never produced in practice, but
    // handled correctly here regardless) still verifies.
    const eventFields = {
      recordType: entry.recordType,
      recordId: entry.recordId === "" ? null : entry.recordId,
      actorEmail: entry.actorEmail === "" ? null : entry.actorEmail,
      action: entry.action,
      previousState: entry.previousState ?? null,
      newState: entry.newState ?? null,
      timestamp: entry.timestamp,
      metadata: entry.metadata || {},
    };
    const recomputed = await computeEntryHash(expectedPrevHash, canonicalize(eventFields));
    if (recomputed !== entry.entryHash) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, reason: "entry content does not match its recorded hash — this entry was altered after being exported" };
    }
    expectedPrevHash = entry.entryHash;
    expectedSeq += 1;
  }
  return { valid: true, count: entries.length };
}

function Section({ title, children }) {
  return (
    <section className="border-t border-white/10 pt-6 mt-6 first:border-t-0 first:pt-0 first:mt-0">
      <h2 className="text-[15px] font-bold text-[var(--inaya-text-primary,#e2e8f0)] mb-2">{title}</h2>
      <div className="text-sm text-[#94a3b8] leading-relaxed space-y-2">{children}</div>
    </section>
  );
}

export default function TrustCenterPage() {
  const [pasted, setPasted] = useState("");
  const [result, setResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [parseError, setParseError] = useState("");

  async function runVerification() {
    setParseError("");
    setResult(null);
    let parsed;
    try {
      parsed = JSON.parse(pasted);
    } catch {
      setParseError("That isn't valid JSON — paste the exact contents of an exported evidence package (Export JSON from your organization's Audit Trail, or a public/v1/evidence response).");
      return;
    }
    const entries = Array.isArray(parsed) ? parsed : parsed.entries;
    if (!Array.isArray(entries)) {
      setParseError('Expected either an array of entries, or an object with an "entries" array — matching the Audit Trail export shape.');
      return;
    }
    setVerifying(true);
    try {
      setResult(await verifyEvidencePackage(entries));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans w-full">
      <div className="max-w-3xl mx-auto px-5 py-14">
        <p className="text-[12px] font-mono font-bold text-[#00f2fe] uppercase tracking-widest mb-2">Inaya Trust Center</p>
        <h1 className="text-3xl font-black tracking-tight mb-3">Don&apos;t just trust Inaya. Verify Inaya.</h1>
        <p className="text-sm text-[#94a3b8] leading-relaxed max-w-xl">
          A transparency layer over the same security, audit, and permission infrastructure Inaya runs on internally — not a
          separate marketing claim. Where something below is independently checkable, this page shows you how to check it
          yourself rather than asking you to take our word for it.
        </p>

        <Section title="Security architecture & controls">
          <p>
            Files are encrypted and sharded client-side before anything reaches the network — no server, node, or
            administrator ever holds a complete, decryptable copy. Consequential AI-initiated actions go through Guarded
            Execution: a human with the same real authority the action itself requires must approve it, and even after
            approval a 36-hour delay passes before it executes, giving time to reconsider or cancel. Access follows a
            department/role permission model enforced server-side on every request, not just hidden in the interface.
          </p>
        </Section>

        <Section title="System / service status">
          <p>
            Live, public threat-intelligence network status (reporting nodes, confirmed threats, network health) is on the{" "}
            <a href="/security" className="text-[#00f2fe] underline">Security transparency page</a> — the same public data
            the mobile and desktop apps&apos; own security screens read from.
          </p>
        </Section>

        <Section title="Compliance-readiness controls">
          <p>
            Inaya implements the operational controls commonly required for SOC 2 / HIPAA / similar frameworks — access
            control, audit logging, incident tracking, data classification, retention policy. <strong>This describes
            controls, not certification</strong> — Inaya has not itself completed a formal SOC 2, HIPAA, ABA, FedRAMP, or
            equivalent certification; that remains a separate workstream, not something this page claims.
          </p>
        </Section>

        <Section title="Audit verification & cryptographic verification">
          <p>
            Every audit-relevant action is written to a hash-linked chain: each entry commits to every entry before it, so
            altering or deleting any past entry breaks every hash after it. An organization&apos;s own Audit Trail view
            (Business Workspace → Audit Trail) exports this chain in full — paste an export below and this page recomputes
            every hash <strong>in your own browser</strong>, matching Inaya&apos;s own verification exactly. This server is
            never trusted for the verification result itself.
          </p>
          <div className="mt-3 bg-[#0b1220] border border-white/10 rounded-xl p-4 space-y-3">
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder='Paste an exported evidence package here, e.g. {"orgId":"...","count":2,"entries":[...]}'
              rows={6}
              className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-[12px] font-mono text-[#e2e8f0] placeholder-[#64748b]"
            />
            <button
              onClick={runVerification}
              disabled={!pasted.trim() || verifying}
              className="text-xs font-bold uppercase px-4 py-2.5 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40"
            >
              {verifying ? "Verifying…" : "Verify in my browser"}
            </button>
            {parseError && <p className="text-red-400 text-xs">{parseError}</p>}
            {result && (
              <div className={`rounded-lg p-3 text-sm font-mono ${result.valid ? "bg-emerald-400/10 border border-emerald-400/30 text-emerald-400" : "bg-red-400/10 border border-red-400/30 text-red-400"}`}>
                {result.valid
                  ? `Verified — ${result.count} ${result.count === 1 ? "entry" : "entries"}, chain intact.`
                  : `Broken${result.brokenAtSeq ? ` at entry #${result.brokenAtSeq}` : ""} — ${result.reason}`}
              </div>
            )}
          </div>
        </Section>

        <Section title="Recovery resilience">
          <p>
            Backup existing is not the same as recovery being proven. Institutions can define recovery requirements
            (an RTO/RPO threshold, critical asset categories, a test frequency) and Inaya continuously runs real,
            non-destructive recovery tests against them — exercising the exact same encryption, replication, and
            reconstruction pipeline described above. Each test produces a real recovery-time/recovery-point
            measurement and a PASS/FAIL result; a resilience test&apos;s evidence uses the identical verifiable
            evidence-package model as the audit chain above, so it can be checked with the same verifier — paste a
            recovery-test evidence export instead of an audit export and it works unchanged. Per-organization
            resilience status is authenticated (Business Workspace → Recovery Resilience), not published here,
            since it would otherwise disclose one customer&apos;s specific security posture publicly.
          </p>
        </Section>

        <Section title="Contract / deployment verification">
          <p>
            Every on-chain contract Inaya runs on is publicly deployed and verifiable — see the{" "}
            <a href="/" className="text-[#00f2fe] underline">Deployed Contracts</a> section on the dApp home page for live
            addresses linked directly to BscScan, not a static list here that could drift out of date.
          </p>
        </Section>

        <Section title="Incident history">
          <p>No publicly disclosed platform-level incidents to date. This section will be updated if that changes — nothing here is a claim that no incident could ever occur.</p>
        </Section>

        <Section title="Data-handling & security policies">
          <p>
            Documents are encrypted and sharded before upload; access is governed by an explicit per-document permission
            model (Private / Department / Project); every access and permission change is recorded in the evidence trail
            described above.
          </p>
        </Section>

        <Section title="Version & change history">
          <p>
            See the <a href="/changelog" className="text-[#00f2fe] underline">changelog</a> for release history.
          </p>
        </Section>
      </div>
    </div>
  );
}
