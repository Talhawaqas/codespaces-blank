// src/lib/governance/classifyRules.js
//
// The deterministic classification rule evaluator (Competitive Expansion SOW D2, CLASS-001). PURE: no database, no network, no server-only
// imports, so the very same function runs on the server (metadata rules, server-managed content) and in a browser or customer scanner
// (end-to-end encrypted content), which is how strongly encrypted files are classified without Inaya ever decrypting them.
//
// A rule: { id, name, level, confidence?, apply: "suggest" | "apply",
//           when: { extensions?, filenameRegex?, pathPrefix?, sourceSystems?, departments?, metadata?: {key: value|[values]},
//                   contentPatterns?: [regex source], terms?: [words], pii?: { types: [...], min?: n } } }
// Every field present must match. Metadata-only conditions work without any content; content conditions (contentPatterns, terms, pii) only
// match when text was supplied, and the result records `contentEvaluated` so nothing implies content was read when it was not.

import { detectPII } from "../aiSecurity/piiDetector.js";

const lower = (v) => String(v ?? "").toLowerCase();
export const MAX_TEXT = 400_000;       // characters examined
export const MAX_PATTERN = 200;        // length of one rule regex
/** Refuse regexes that can backtrack catastrophically (nested quantifiers, quantified alternation overlap). A heuristic, documented as one. */
export function safePattern(src) {
  const s = String(src ?? "");
  if (!s || s.length > MAX_PATTERN) return false;
  if (/(\([^)]*[+*][^)]*\))[+*{]/.test(s) || /(\.\*){3,}/.test(s) || /\([^)]*\|[^)]*\)[+*]{1}/.test(s) && /\([^)]*[+*]/.test(s)) return false;
  try { new RegExp(s, "i"); return true; } catch { return false; }
}

/** Pure. Returns { matched, why[], contentEvaluated } for one rule against a file description. */
export function ruleMatches(rule, file, text) {
  const w = rule.when || {}; const why = []; let contentEvaluated = false;
  const ext = lower(String(file.filename ?? "").includes(".") ? String(file.filename).split(".").pop() : "");
  if (w.extensions?.length) { if (!w.extensions.map(lower).includes(ext)) return { matched: false }; why.push(`file type .${ext}`); }
  if (w.filenameRegex) { if (!safePattern(w.filenameRegex) || !new RegExp(w.filenameRegex, "i").test(String(file.filename ?? ""))) return { matched: false }; why.push(`file name matches ${w.filenameRegex}`); }
  if (w.pathPrefix) { if (!String(file.path ?? file.filename ?? "").startsWith(w.pathPrefix)) return { matched: false }; why.push(`path starts with ${w.pathPrefix}`); }
  if (w.sourceSystems?.length) { if (!w.sourceSystems.map(lower).includes(lower(file.source))) return { matched: false }; why.push(`source ${file.source}`); }
  if (w.departments?.length) { if (!w.departments.map(String).includes(String(file.departmentId ?? ""))) return { matched: false }; why.push("department"); }
  if (w.metadata) for (const [k, v] of Object.entries(w.metadata)) {
    const have = file.metadata?.[k]; const want = Array.isArray(v) ? v : [v];
    if (have === undefined || !want.map((x) => lower(x)).includes(lower(have))) return { matched: false }; why.push(`${k} is ${have}`);
  }
  const needsContent = !!(w.contentPatterns?.length || w.terms?.length || w.pii);
  if (needsContent) {
    if (typeof text !== "string" || !text) return { matched: false, contentMissing: true };
    contentEvaluated = true; const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
    for (const src of w.contentPatterns || []) { if (!safePattern(src) || !new RegExp(src, "i").test(t)) return { matched: false, contentEvaluated }; why.push(`content matches ${src}`); }
    const tl = t.toLowerCase();
    if (w.terms?.length) { const hit = w.terms.filter((x) => tl.includes(lower(x))); if (!hit.length) return { matched: false, contentEvaluated }; why.push(`contains ${hit.slice(0, 3).join(", ")}`); }
    if (w.pii) {
      const found = detectPII(t).found; const types = w.pii.types?.length ? found.filter((f) => w.pii.types.includes(f.type)) : found;
      if (types.length < (w.pii.min ?? 1)) return { matched: false, contentEvaluated };
      why.push(`personal data found (${[...new Set(types.map((x) => x.type))].join(", ")})`);
    }
  }
  if (!why.length) return { matched: false }; // a rule with no conditions never matches everything by accident
  return { matched: true, why, contentEvaluated };
}

/**
 * Pure. `rules` = [{ ...rule, policyKey, policyVersion }] in precedence order; `levelOrder` maps level key -> rank (higher = more sensitive).
 * The most sensitive matching level wins; ties keep the first rule. Returns the explanation of every match.
 */
export function evaluateClassification(rules, file, text, levelOrder = {}) {
  const matches = []; let contentSkipped = false; let contentEvaluated = false;
  for (const r of rules) {
    const m = ruleMatches(r, file, text); if (m.contentMissing) contentSkipped = true; if (m.contentEvaluated) contentEvaluated = true;
    if (m.matched) matches.push({ ruleId: r.id, ruleName: r.name || null, policyKey: r.policyKey, policyVersion: r.policyVersion, level: r.level, confidence: Number(r.confidence ?? 0.9), apply: r.apply === "apply" ? "apply" : "suggest", explanation: `Matched: ${m.why.join("; ")}` });
  }
  if (!matches.length) return { level: null, confidence: 0, matches: [], contentEvaluated, contentSkipped };
  const best = matches.reduce((a, b) => ((levelOrder[b.level] ?? -1) > (levelOrder[a.level] ?? -1) ? b : a));
  const sameLevel = matches.filter((m) => m.level === best.level);
  return { level: best.level, confidence: Math.max(...sameLevel.map((m) => m.confidence)), apply: sameLevel.every((m) => m.apply === "apply") ? "apply" : "suggest", matches, contentEvaluated, contentSkipped };
}
