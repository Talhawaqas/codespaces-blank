// src/lib/workflows/transform.js
//
// SOW §11 -- merge / join / filter / map / select / rename / sort / aggregate /
// group / deduplicate / derive. Pure functions over plain JSON. There is no
// code-execution node: any per-row logic is written in the constrained
// expression language (expr.js) or chosen from these fixed operators.

import { parseExpression, evaluateAst, ExprError } from "./expr.js";

export const MAX_ROWS = 5000;
const BLOCKED = new Set(["__proto__", "prototype", "constructor"]);

function rows(v) {
  if (Array.isArray(v)) return v.slice(0, MAX_ROWS);
  if (v === null || v === undefined) return [];
  if (typeof v === "object") {
    for (const k of ["rows", "tickets", "invoices", "tasks", "deals", "events", "products", "projects"]) if (Array.isArray(v[k])) return v[k].slice(0, MAX_ROWS);
  }
  return [v];
}
function get(row, path) {
  let cur = row;
  for (const seg of String(path).split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object" || BLOCKED.has(seg)) return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined;
  }
  return cur;
}
function setPath(obj, path, value) {
  const segs = String(path).split(".");
  if (segs.some((s) => BLOCKED.has(s) || !s)) throw new Error(`Invalid field name "${path}".`);
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (typeof cur[segs[i]] !== "object" || cur[segs[i]] === null) cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
}
const rowScope = (row) => ({ row, ...(row && typeof row === "object" ? row : {}) });

/** merge: combine several named inputs into one object, or concat row arrays. */
export function mergeInputs(inputs, { mode = "object" } = {}) {
  const entries = Object.entries(inputs || {});
  if (mode === "concat") return { rows: entries.flatMap(([, v]) => rows(v)).slice(0, MAX_ROWS), sources: entries.map(([k]) => k) };
  const merged = {};
  for (const [k, v] of entries) { if (!BLOCKED.has(k)) merged[k] = v; }
  return { ...merged, _sources: entries.map(([k]) => k) };
}

export function joinRows(left, right, { leftKey, rightKey, type = "inner", prefix = "right_" }) {
  if (!leftKey || !rightKey) throw new Error("join needs leftKey and rightKey.");
  const R = rows(right);
  const index = new Map();
  for (const r of R) { const k = String(get(r, rightKey)); if (!index.has(k)) index.set(k, []); index.get(k).push(r); }
  const out = [];
  for (const l of rows(left)) {
    const matches = index.get(String(get(l, leftKey))) || [];
    if (matches.length) for (const m of matches) { const o = { ...l }; for (const [k, v] of Object.entries(m)) { if (!BLOCKED.has(k)) o[Object.prototype.hasOwnProperty.call(l, k) ? prefix + k : k] = v; } out.push(o); }
    else if (type === "left") out.push({ ...l });
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

export function filterRows(input, expression) {
  const ast = parseExpression(expression);
  return rows(input).filter((row) => Boolean(evaluateAst(ast, rowScope(row))));
}

/** map: for each row, compute new fields from expressions. { field: "expression" } */
export function mapRows(input, fields, { keep = true } = {}) {
  const asts = Object.entries(fields || {}).map(([k, e]) => [k, parseExpression(String(e))]);
  return rows(input).map((row) => {
    const out = keep && row && typeof row === "object" ? { ...row } : {};
    for (const [k, ast] of asts) setPath(out, k, evaluateAst(ast, rowScope(row)));
    return out;
  });
}
/** derive: same as map, but always keeps the original fields. */
export const deriveFields = (input, fields) => mapRows(input, fields, { keep: true });

export function selectFields(input, fields) {
  const list = (fields || []).map(String);
  return rows(input).map((row) => { const o = {}; for (const f of list) { const v = get(row, f); if (v !== undefined) setPath(o, f, v); } return o; });
}

export function renameFields(input, mapping) {
  return rows(input).map((row) => {
    const o = { ...row };
    for (const [from, to] of Object.entries(mapping || {})) {
      if (BLOCKED.has(from) || BLOCKED.has(to)) continue;
      if (Object.prototype.hasOwnProperty.call(o, from)) { o[to] = o[from]; delete o[from]; }
    }
    return o;
  });
}

export function sortRows(input, { by, direction = "asc" }) {
  if (!by) throw new Error("sort needs a field (by).");
  const dir = direction === "desc" ? -1 : 1;
  return rows(input).slice().sort((a, b) => {
    const x = get(a, by), y = get(b, by);
    if (x === y) return 0;
    if (x === undefined || x === null) return 1;
    if (y === undefined || y === null) return -1;
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}

export function dedupeRows(input, { keys } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of rows(input)) {
    const k = keys?.length ? JSON.stringify(keys.map((f) => get(r, f) ?? null)) : JSON.stringify(r);
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

const AGG = {
  count: (xs) => xs.length,
  sum: (xs) => xs.reduce((a, x) => a + (Number(x) || 0), 0),
  avg: (xs) => (xs.length ? xs.reduce((a, x) => a + (Number(x) || 0), 0) / xs.length : 0),
  min: (xs) => (xs.length ? Math.min(...xs.map(Number)) : null),
  max: (xs) => (xs.length ? Math.max(...xs.map(Number)) : null),
};

/** aggregate: [{ as, op, field }] over all rows -> one object. */
export function aggregateRows(input, metrics) {
  const R = rows(input);
  const out = {};
  for (const m of metrics || []) {
    if (!AGG[m.op]) throw new Error(`Unknown aggregate "${m.op}". Use one of ${Object.keys(AGG).join(", ")}.`);
    if (BLOCKED.has(m.as)) continue;
    out[m.as || `${m.op}_${m.field || "rows"}`] = AGG[m.op](m.field ? R.map((r) => get(r, m.field)).filter((v) => v !== undefined && v !== null) : R);
  }
  return out;
}

/** group: group rows by field(s) and aggregate each group. */
export function groupRows(input, { by, metrics = [{ as: "count", op: "count" }] }) {
  const keys = Array.isArray(by) ? by : [by];
  if (!keys.length || !keys[0]) throw new Error("group needs a field (by).");
  const groups = new Map();
  for (const r of rows(input)) {
    const k = JSON.stringify(keys.map((f) => get(r, f) ?? null));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].slice(0, MAX_ROWS).map(([k, list]) => {
    const vals = JSON.parse(k);
    const o = {};
    keys.forEach((f, i) => setPath(o, f, vals[i]));
    return { ...o, ...aggregateRows(list, metrics) };
  });
}

export { ExprError };
