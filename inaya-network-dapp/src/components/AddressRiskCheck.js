"use client";

// src/components/AddressRiskCheck.js
//
// Wallet-attack protection, scoped to what's actually easy and safe to add:
// a real browser extension doesn't exist anywhere in this repo and isn't a
// small addition (new codebase, build tooling, store review/signing,
// content-script injection into arbitrary pages) — so instead of that,
// this wires the EXISTING, real Security Layer (src/lib/security.js's
// threat registry, already backing the public /security page) directly
// into a destination-address input, the actual "am I about to send my
// funds to a scammer" moment. Purely additive: read-only, debounced,
// self-contained — never touches the caller's own address state,
// transaction logic, or submit handler. Drop it under any input that
// collects a destination address.
//
// Deliberately silent (no banner) for "unknown" — an address with no
// report against it is NOT a safety guarantee, just the honest "we have
// no data" answer, same discipline getThreatByIndicator() itself
// documents. Only a real CONFIRMED or DISPUTED record from the live
// registry produces a warning.

import { useState, useEffect } from "react";

const DEBOUNCE_MS = 600;
const MIN_LENGTH = 8; // don't fire on a half-typed address

// security.js's SECURITY_CATEGORIES, mirrored client-side (that module is
// server-only — imports ethers/mongodb) — same "own client-side copy of
// the display labels" pattern app/security/page.js's CATEGORY_META
// already uses for the exact same reason. The API returns category as a
// numeric index, not a label.
const CATEGORY_LABELS = ["an unclassified", "a phishing", "a malware", "a scam", "a botnet/C2", "a spam", "an other-category"];

function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? "an unclassified";
}

async function checkAddress(address, signal) {
  const res = await fetch(`/api/security/threat?indicator=${encodeURIComponent(address)}`, { signal });
  if (!res.ok) throw new Error("Threat check failed.");
  return res.json();
}

export default function AddressRiskCheck({ address }) {
  const [result, setResult] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setResult(null);
    const trimmed = (address || "").trim();
    if (trimmed.length < MIN_LENGTH) return;

    const controller = new AbortController();
    setChecking(true);
    const timer = setTimeout(() => {
      checkAddress(trimmed, controller.signal)
        .then((data) => setResult(data))
        .catch((err) => {
          if (err.name !== "AbortError") console.warn("AddressRiskCheck: check failed (non-fatal):", err.message);
        })
        .finally(() => setChecking(false));
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
      setChecking(false);
    };
  }, [address]);

  if (!result || !result.known) return null; // silent — no report on file, nothing to warn about

  const isConfirmed = result.statusLabel === "confirmed";
  const isDisputed = result.statusLabel === "disputed";
  if (!isConfirmed && !isDisputed) return null;

  const style = isConfirmed
    ? { bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.4)", text: "#f87171", icon: "⚠️" }
    : { bg: "rgba(250,204,21,0.1)", border: "rgba(250,204,21,0.4)", text: "#facc15", icon: "❔" };

  return (
    <div
      role="alert"
      style={{
        marginTop: 8, padding: "10px 12px", borderRadius: 8, fontSize: 13, lineHeight: 1.5,
        background: style.bg, border: `1px solid ${style.border}`, color: style.text,
      }}
    >
      {style.icon}{" "}
      {isConfirmed
        ? `This address has ${categoryLabel(result.category)} report CONFIRMED on Inaya's Security Layer. Sending funds here is likely unsafe.`
        : `This address has a DISPUTED report on Inaya's Security Layer — unverified, but worth double-checking before you send.`}{" "}
      <a href="/security" target="_blank" rel="noreferrer" style={{ color: style.text, textDecoration: "underline" }}>
        View on Security Center
      </a>
    </div>
  );
}
