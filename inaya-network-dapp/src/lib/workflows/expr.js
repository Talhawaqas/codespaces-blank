// src/lib/workflows/expr.js
//
// AI Business Operations Manager SOW §11 / §17: a constrained expression
// engine. It is a hand-written tokenizer + recursive-descent parser + tree
// walker. There is NO eval / new Function / dynamic import anywhere: an
// expression can only read values from the scope object it is given, compare
// and combine them, and call a small fixed set of pure functions. It cannot
// reach globals, prototypes, the filesystem or the network, and it is bounded
// (length, depth, evaluation steps), so a malicious workflow definition cannot
// hang or escape the engine.
//
// Grammar (lowest precedence first):
//   or      := and ( ("||" | "or") and )*
//   and     := not ( ("&&" | "and") not )*
//   not     := ("!" | "not") not | cmp
//   cmp     := add ( ("==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "in") add )?
//   add     := mul ( ("+" | "-") mul )*
//   mul     := unary ( ("*" | "/" | "%") unary )*
//   unary   := "-" unary | primary
//   primary := number | string | true | false | null | path | call | "(" or ")"
//   path    := ident ( "." ident | "[" (number|string) "]" )*
//   call    := ident "(" [ or ("," or)* ] ")"

export const MAX_EXPR_LENGTH = 1000;
const MAX_DEPTH = 30;
const MAX_STEPS = 20000;
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class ExprError extends Error {
  constructor(message) { super(message); this.name = "ExprError"; }
}

// ------------------------------------------------------------------ tokens
function tokenize(src) {
  if (typeof src !== "string") throw new ExprError("Expression must be text.");
  if (src.length > MAX_EXPR_LENGTH) throw new ExprError(`Expression is longer than ${MAX_EXPR_LENGTH} characters.`);
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const n = Number(src.slice(i, j));
      if (!Number.isFinite(n)) throw new ExprError(`Bad number "${src.slice(i, j)}".`);
      tokens.push({ t: "num", v: n }); i = j; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, out = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j++; }
      }
      if (src[j] !== c) throw new ExprError("Unterminated string.");
      tokens.push({ t: "str", v: out }); i = j + 1; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      tokens.push({ t: "id", v: src.slice(i, j) }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) { tokens.push({ t: "op", v: two }); i += 2; continue; }
    if ("<>!+-*/%().,[]".includes(c)) { tokens.push({ t: "op", v: c }); i++; continue; }
    throw new ExprError(`Unexpected character "${c}".`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser
export function parseExpression(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v) => tokens[pos]?.t === "op" && tokens[pos].v === v;
  const isWord = (v) => tokens[pos]?.t === "id" && tokens[pos].v.toLowerCase() === v;
  const eatOp = (v) => { if (isOp(v)) { pos++; return true; } return false; };

  function parseOr(d) {
    if (d > MAX_DEPTH) throw new ExprError("Expression is nested too deeply.");
    let left = parseAnd(d + 1);
    while (isOp("||") || isWord("or")) { pos++; left = { k: "or", a: left, b: parseAnd(d + 1) }; }
    return left;
  }
  function parseAnd(d) {
    let left = parseNot(d + 1);
    while (isOp("&&") || isWord("and")) { pos++; left = { k: "and", a: left, b: parseNot(d + 1) }; }
    return left;
  }
  function parseNot(d) {
    if (d > MAX_DEPTH) throw new ExprError("Expression is nested too deeply.");
    if (isOp("!") || isWord("not")) { pos++; return { k: "not", a: parseNot(d + 1) }; }
    return parseCmp(d + 1);
  }
  function parseCmp(d) {
    const left = parseAdd(d + 1);
    const t = peek();
    if (t?.t === "op" && ["==", "!=", ">", ">=", "<", "<="].includes(t.v)) { pos++; return { k: "cmp", op: t.v, a: left, b: parseAdd(d + 1) }; }
    if (isWord("contains")) { pos++; return { k: "cmp", op: "contains", a: left, b: parseAdd(d + 1) }; }
    if (isWord("in")) { pos++; return { k: "cmp", op: "in", a: left, b: parseAdd(d + 1) }; }
    return left;
  }
  function parseAdd(d) {
    let left = parseMul(d + 1);
    while (isOp("+") || isOp("-")) { const op = tokens[pos++].v; left = { k: "bin", op, a: left, b: parseMul(d + 1) }; }
    return left;
  }
  function parseMul(d) {
    let left = parseUnary(d + 1);
    while (isOp("*") || isOp("/") || isOp("%")) { const op = tokens[pos++].v; left = { k: "bin", op, a: left, b: parseUnary(d + 1) }; }
    return left;
  }
  function parseUnary(d) {
    if (d > MAX_DEPTH) throw new ExprError("Expression is nested too deeply.");
    if (isOp("-")) { pos++; return { k: "neg", a: parseUnary(d + 1) }; }
    return parsePrimary(d + 1);
  }
  function parsePrimary(d) {
    const t = peek();
    if (!t) throw new ExprError("Expression ended unexpectedly.");
    if (t.t === "num") { pos++; return { k: "lit", v: t.v }; }
    if (t.t === "str") { pos++; return { k: "lit", v: t.v }; }
    if (t.t === "op" && t.v === "(") { pos++; const e = parseOr(d + 1); if (!eatOp(")")) throw new ExprError('Missing ")".'); return e; }
    if (t.t === "id") {
      const lower = t.v.toLowerCase();
      if (lower === "true") { pos++; return { k: "lit", v: true }; }
      if (lower === "false") { pos++; return { k: "lit", v: false }; }
      if (lower === "null") { pos++; return { k: "lit", v: null }; }
      pos++;
      if (isOp("(")) {
        pos++;
        const args = [];
        if (!isOp(")")) { do { args.push(parseOr(d + 1)); } while (eatOp(",")); }
        if (!eatOp(")")) throw new ExprError('Missing ")" after function arguments.');
        if (!FUNCTIONS[t.v]) throw new ExprError(`Unknown function "${t.v}".`);
        return { k: "call", name: t.v, args };
      }
      const path = [t.v];
      for (;;) {
        if (isOp(".")) {
          pos++;
          const n = peek();
          if (!n || n.t !== "id") throw new ExprError('Expected a name after ".".');
          pos++; path.push(n.v);
        } else if (isOp("[")) {
          pos++;
          const n = peek();
          if (!n || (n.t !== "num" && n.t !== "str")) throw new ExprError("Only a number or a quoted name is allowed in [ ].");
          pos++;
          if (!eatOp("]")) throw new ExprError('Missing "]".');
          path.push(n.v);
        } else break;
      }
      for (const seg of path) if (typeof seg === "string" && BLOCKED_KEYS.has(seg)) throw new ExprError(`"${seg}" is not allowed in an expression.`);
      return { k: "path", path };
    }
    throw new ExprError(`Unexpected "${t.v}".`);
  }

  const ast = parseOr(0);
  if (pos < tokens.length) throw new ExprError(`Unexpected "${tokens[pos].v}".`);
  return ast;
}

// --------------------------------------------------------------- functions
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
function pluck(list, field) { return arr(list).map((x) => (field ? getPath(x, String(field).split(".")) : x)); }

const FUNCTIONS = {
  count: (list) => arr(list).length,
  len: (v) => (typeof v === "string" || Array.isArray(v) ? v.length : 0),
  sum: (list, field) => pluck(list, field).reduce((a, x) => a + num(x), 0),
  avg: (list, field) => { const xs = pluck(list, field); return xs.length ? xs.reduce((a, x) => a + num(x), 0) / xs.length : 0; },
  min: (list, field) => { const xs = pluck(list, field).map(num); return xs.length ? Math.min(...xs) : null; },
  max: (list, field) => { const xs = pluck(list, field).map(num); return xs.length ? Math.max(...xs) : null; },
  exists: (v) => v !== undefined && v !== null && v !== "",
  lower: (v) => String(v ?? "").toLowerCase(),
  upper: (v) => String(v ?? "").toUpperCase(),
  round: (v, digits = 0) => { const f = 10 ** Math.max(0, Math.min(6, num(digits))); return Math.round(num(v) * f) / f; },
  abs: (v) => Math.abs(num(v)),
  coalesce: (...vs) => vs.find((v) => v !== undefined && v !== null && v !== "") ?? null,
  contains: (a, b) => containsOp(a, b),
  startsWith: (a, b) => String(a ?? "").startsWith(String(b ?? "")),
  daysSince: (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null; },
  countWhere: (list, field, value) => arr(list).filter((x) => getPath(x, String(field).split(".")) === value).length,
  // number of rows where the numeric field is above a threshold -- the common
  // "how many invoices are over $10,000" question without a filter node
  countAbove: (list, field, threshold) => arr(list).filter((x) => num(getPath(x, String(field).split("."))) > num(threshold)).length,
};
export const EXPRESSION_FUNCTIONS = Object.keys(FUNCTIONS);

function getPath(obj, path) {
  let cur = obj;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "string" && BLOCKED_KEYS.has(seg)) return undefined;
    if (typeof cur !== "object") return undefined;
    if (Array.isArray(cur) && typeof seg === "string" && seg === "length") { cur = cur.length; continue; }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function containsOp(a, b) {
  if (Array.isArray(a)) return a.some((x) => x === b || (typeof x === "string" && typeof b === "string" && x.toLowerCase() === b.toLowerCase()));
  if (typeof a === "string") return a.toLowerCase().includes(String(b ?? "").toLowerCase());
  return false;
}

// -------------------------------------------------------------- evaluation
export function evaluateAst(ast, scope) {
  let steps = 0;
  const step = () => { if (++steps > MAX_STEPS) throw new ExprError("Expression is too expensive to evaluate."); };
  function ev(n) {
    step();
    switch (n.k) {
      case "lit": return n.v;
      case "path": return getPath(scope, n.path);
      case "or": return Boolean(ev(n.a)) || Boolean(ev(n.b));
      case "and": return Boolean(ev(n.a)) && Boolean(ev(n.b));
      case "not": return !ev(n.a);
      case "neg": return -num(ev(n.a));
      case "bin": {
        const a = ev(n.a), b = ev(n.b);
        if (n.op === "+") return typeof a === "string" || typeof b === "string" ? `${a ?? ""}${b ?? ""}` : num(a) + num(b);
        if (n.op === "-") return num(a) - num(b);
        if (n.op === "*") return num(a) * num(b);
        if (n.op === "/") return num(b) === 0 ? null : num(a) / num(b);
        return num(b) === 0 ? null : num(a) % num(b);
      }
      case "cmp": {
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          case "==": return looseEq(a, b);
          case "!=": return !looseEq(a, b);
          case "contains": return containsOp(a, b);
          case "in": return containsOp(b, a);
          default: {
            if (a === undefined || a === null || b === undefined || b === null) return false;
            const bothNum = typeof a === "number" && typeof b === "number";
            const x = bothNum ? a : typeof a === "string" && typeof b === "string" && Number.isNaN(Number(a)) ? a : num(a);
            const y = bothNum ? b : typeof a === "string" && typeof b === "string" && Number.isNaN(Number(a)) ? b : num(b);
            return n.op === ">" ? x > y : n.op === ">=" ? x >= y : n.op === "<" ? x < y : x <= y;
          }
        }
      }
      case "call": return FUNCTIONS[n.name](...n.args.map(ev));
      default: throw new ExprError("Unsupported expression.");
    }
  }
  return ev(ast);
}

function looseEq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return false;
}

/** Parse + evaluate. Throws ExprError. */
export function evaluate(src, scope) {
  return evaluateAst(parseExpression(src), scope);
}

/** Validates syntax + that every function exists, without evaluating. */
export function validateExpression(src) {
  try { parseExpression(src); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
}

/** Boolean evaluation for conditions: an expression error fails CLOSED to false
 *  is NOT what we want for correctness, so the caller decides -- this throws. */
export function evaluateCondition(src, scope) {
  return Boolean(evaluate(src, scope));
}

// --------------------------------------------------------------- templates
/** Replaces {{ expression }} in text. Bounded output; objects are JSON. An
 *  expression error renders as "[?]" (a template never throws on data). */
export function renderTemplate(text, scope, { maxLength = 20000 } = {}) {
  if (typeof text !== "string") return "";
  const out = text.replace(/\{\{([^{}]{1,500})\}\}/g, (_, expr) => {
    try {
      const v = evaluate(expr.trim(), scope);
      if (v === undefined || v === null) return "";
      if (typeof v === "object") return JSON.stringify(v).slice(0, 2000);
      return String(v);
    } catch { return "[?]"; }
  });
  return out.length > maxLength ? out.slice(0, maxLength) : out;
}
