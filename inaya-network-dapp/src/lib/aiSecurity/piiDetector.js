// src/lib/aiSecurity/piiDetector.js
//
// Inaya AI Security Workflow 2026 SOW, Phase 4/8 (§9.4, §13.3). Real,
// deterministic PII detection -- the Phase 0 audit confirmed NO PII
// detection exists anywhere in the repo today. Pattern-based, not a
// trained classifier: it will catch well-formed identifiers (an email,
// a US SSN shape, a Luhn-valid card number) and will miss free-text PII
// that doesn't match a structural pattern (e.g. "the patient living at
// 12 Oak Street"). Reported as what it is -- a real, useful, non-exhaustive
// first layer -- not a complete PII solution.

const DETECTORS = [
  { type: "EMAIL", pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, severity: "LOW" },
  { type: "PHONE", pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, severity: "LOW" },
  { type: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, severity: "HIGH" },
  // Candidate credit-card-shaped sequences -- validated by Luhn below
  // before being reported, so an ordinary 16-digit invoice/PO number
  // doesn't get misreported as a real card number.
  { type: "CREDIT_CARD", pattern: /\b(?:\d[ -]?){13,19}\b/g, severity: "HIGH", validate: luhnValid },
];

function luhnValid(candidate) {
  const digits = candidate.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19 || !/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alternate) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** Scans text and returns every PII category found, with counts -- never
 *  the raw matched values themselves in the return (callers that need the
 *  actual matches for redaction call redactPII, which never leaves the
 *  matched substrings in its own return value either — see its header). */
export function detectPII(text) {
  const input = String(text || "");
  const found = [];
  let highSensitivity = false;

  for (const detector of DETECTORS) {
    const matches = [...input.matchAll(detector.pattern)].map((m) => m[0]);
    const valid = detector.validate ? matches.filter(detector.validate) : matches;
    if (valid.length > 0) {
      found.push({ type: detector.type, count: valid.length, severity: detector.severity });
      if (detector.severity === "HIGH" || detector.severity === "CRITICAL") highSensitivity = true;
    }
  }

  return { found, hasHighSensitivity: highSensitivity, hasAny: found.length > 0 };
}

/** Replaces every detected PII match with a typed placeholder
 *  (`[REDACTED:EMAIL]`) -- preserves sentence structure so the redacted
 *  text is still readable, per the SOW's "never silently destroy business
 *  meaning" rule (§9.4). Returns only the redacted text and a summary
 *  count, never the original matched substrings, so a caller can't
 *  accidentally log/return the very values this function exists to hide. */
export function redactPII(text) {
  let output = String(text || "");
  const redactedCounts = {};

  for (const detector of DETECTORS) {
    output = output.replace(detector.pattern, (match) => {
      if (detector.validate && !detector.validate(match)) return match;
      redactedCounts[detector.type] = (redactedCounts[detector.type] || 0) + 1;
      return `[REDACTED:${detector.type}]`;
    });
  }

  return { text: output, redactedCounts, wasRedacted: Object.keys(redactedCounts).length > 0 };
}
