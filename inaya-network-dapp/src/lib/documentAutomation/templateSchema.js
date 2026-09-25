// src/lib/documentAutomation/templateSchema.js
//
// Document Automation SOW §5 -- the safe, versioned template language.
//
// A template is DATA, never code. It is a JSON document made of a fixed
// vocabulary of block types; every string field is either literal text or a
// `{{namespace.field}}` reference resolved against a whitelist of fields
// the engine itself populated. There is no expression language, no eval,
// no filesystem/network/database access and no HTML: the renderer draws
// text with pdfkit, so markup in a value is printed, never interpreted.
// Values substituted into a template are inserted verbatim and are NEVER
// re-scanned for `{{...}}` (source-field template injection is impossible).
//
// validateTemplateSpec() rebuilds the spec from an allowlist of keys --
// unknown keys are rejected, not carried through -- and enforces size and
// depth limits (resource exhaustion). Conditions are a closed set of
// operators over whitelisted paths (§5 "controlled conditions").

import { canonicalHash, jsonSafe } from "./manifest.js";
import { LABEL_KEYS, SUPPORTED_LOCALES, normalizeLocale } from "./i18n.js";

export const TEMPLATE_SCHEMA_ID = "inaya.doc-template/1";
export const MAX_SPEC_BYTES = 64 * 1024;
export const MAX_BLOCKS = 60;
const MAX_STRING = 600;
const MAX_FIELDS = 24;
const MAX_COLUMNS = 8;
const MAX_COND_DEPTH = 3;
const MAX_COND_ITEMS = 8;

export const DOCUMENT_TYPES = [
  "invoice", "purchase_order", "quotation", "receipt", "statement",
  "credit_note", "debit_note", "delivery_note", "business_report",
];

export const BLOCK_TYPES = ["header", "parties", "meta", "table", "totals", "text", "approval", "signature", "spacer", "divider"];
export const FORMATS = ["text", "date", "datetime", "number", "integer", "currency", "percent"];
export const TABLE_SOURCES = {
  lines: ["description", "sku", "quantity", "unitPrice", "lineDiscount", "lineTax", "lineTotal", "taxRate"],
  deliveryLines: ["description", "sku", "ordered", "delivered", "pending"],
  statementRows: ["date", "reference", "kind", "charge", "payment", "balance"],
  kpiRows: ["label", "value", "change"],
  bulletRows: ["text"],
};
export const CONDITION_OPS = ["exists", "notExists", "truthy", "falsy", "eq", "neq", "gt", "gte", "lt", "lte", "in"];

const COMMON_PATHS = [
  "doc.number", "doc.version", "doc.issueDate", "doc.dueDate", "doc.validUntil", "doc.status", "doc.currency",
  "doc.reference", "doc.poNumber", "doc.paymentTerms", "doc.notes", "doc.terms", "doc.generatedAt", "doc.reason",
  "doc.originalNumber", "doc.originalDate", "doc.periodFrom", "doc.periodTo", "doc.paymentMethod", "doc.paymentDate",
  "doc.title", "doc.summary", "doc.approvalNote",
  "org.name", "org.legalName", "org.addressLines", "org.email", "org.phone", "org.taxId", "org.taxLabel", "org.website", "org.footerNote",
  "party.name", "party.company", "party.email", "party.phone", "party.taxId", "party.addressLines", "party.shipToLines",
  "calc.subtotal", "calc.lineDiscountTotal", "calc.invoiceDiscount", "calc.taxableAmount", "calc.tax", "calc.totalTax",
  "calc.lineTaxTotal", "calc.shipping", "calc.fees", "calc.grandTotal", "calc.amountPaid", "calc.amountDue",
  "calc.openingBalance", "calc.closingBalance", "calc.totalCharges", "calc.totalPayments",
  "approval.required", "approval.status", "approval.approvedBy", "approval.approvedAt", "approval.version",
  "flags.hasTax", "flags.hasDiscount", "flags.hasShipping", "flags.hasFees", "flags.hasPaymentTerms", "flags.hasNotes",
  "flags.hasAmountPaid", "flags.shippingAddressDiffers", "flags.approvalRequired", "flags.currencyDiffersFromDefault",
  "flags.isPreview", "flags.isFinal",
  "verify.url", "verify.documentId", "verify.hash",
];
export const FIELD_PATHS = Object.fromEntries(DOCUMENT_TYPES.map((t) => [t, COMMON_PATHS]));
const ALL_PATHS = new Set(COMMON_PATHS);

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/;
const BANNED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const INTERP_RE = /\{\{\s*([A-Za-z0-9_.]+)(?:\|([a-z]+))?\s*\}\}/g;

const KEYSETS = {
  root: ["schema", "documentType", "name", "description", "locale", "page", "style", "requiredSources", "blocks", "footer", "numbering", "currency"],
  currency: ["display", "allowed"],
  page: ["size", "margins", "orientation"],
  margins: ["top", "right", "bottom", "left"],
  style: ["accentColor", "fontScale", "showLogo"],
  numbering: ["prefix", "fiscalYearReset"],
  footer: ["text", "pageNumbers", "showDocumentId", "showHash", "showVerify"],
  header: ["type", "titleLabel", "showLogo", "showOrgAddress", "showTaxId", "fields", "when"],
  parties: ["type", "columns", "when"],
  partyColumn: ["titleLabel", "lines", "when"],
  meta: ["type", "titleLabel", "fields", "columns", "when"],
  field: ["labelKey", "value", "format", "when"],
  table: ["type", "titleLabel", "source", "columns", "repeatHeader", "emptyText", "when"],
  column: ["key", "labelKey", "format", "width", "align"],
  totals: ["type", "rows", "when"],
  totalRow: ["labelKey", "path", "format", "negate", "emphasize", "when"],
  text: ["type", "titleLabel", "text", "size", "muted", "when"],
  approval: ["type", "when"],
  signature: ["type", "lines", "when"],
  sigLine: ["labelKey", "path"],
  spacer: ["type", "height"],
  divider: ["type"],
};

function rejectUnknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) {
    if (BANNED_SEGMENTS.has(k)) { errors.push(`${where}: forbidden key "${k}".`); continue; }
    if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}".`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkString(value, where, errors, { max = MAX_STRING, required = false } = {}) {
  if (value === undefined || value === null) { if (required) errors.push(`${where}: is required.`); return undefined; }
  if (typeof value !== "string") { errors.push(`${where}: must be a string.`); return undefined; }
  if (value.length > max) { errors.push(`${where}: is longer than ${max} characters.`); return undefined; }
  // Control characters have no place in document text and are a classic
  // smuggling vector for downstream consumers.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) { errors.push(`${where}: contains control characters.`); return undefined; }
  return value;
}

function checkPath(path, where, errors) {
  if (typeof path !== "string" || !PATH_RE.test(path)) { errors.push(`${where}: "${String(path).slice(0, 60)}" is not a valid field path.`); return null; }
  if (path.split(".").some((s) => BANNED_SEGMENTS.has(s))) { errors.push(`${where}: forbidden path segment.`); return null; }
  if (!ALL_PATHS.has(path)) { errors.push(`${where}: "${path}" is not a field the engine provides.`); return null; }
  return path;
}

function checkTemplateString(text, where, errors) {
  const value = checkString(text, where, errors);
  if (value === undefined) return undefined;
  for (const m of value.matchAll(INTERP_RE)) {
    checkPath(m[1], `${where} {{${m[1]}}}`, errors);
    if (m[2] && !FORMATS.includes(m[2])) errors.push(`${where}: unknown format "${m[2]}".`);
  }
  // Any brace pair that is NOT a well-formed reference is rejected so a
  // typo can't silently render as literal braces.
  const stripped = value.replace(INTERP_RE, "");
  if (/\{\{|\}\}/.test(stripped)) errors.push(`${where}: contains a malformed {{ }} reference.`);
  return value;
}

function checkLabelKey(key, where, errors, { required = false } = {}) {
  if (key === undefined || key === null) { if (required) errors.push(`${where}: is required.`); return undefined; }
  if (typeof key !== "string" || !LABEL_KEYS.includes(key)) { errors.push(`${where}: "${String(key).slice(0, 40)}" is not a known label.`); return undefined; }
  return key;
}

function checkFormat(fmt, where, errors) {
  if (fmt === undefined) return undefined;
  if (!FORMATS.includes(fmt)) { errors.push(`${where}: unknown format "${fmt}".`); return undefined; }
  return fmt;
}

function checkCondition(cond, where, errors, depth = 0) {
  if (cond === undefined) return undefined;
  if (!isPlainObject(cond)) { errors.push(`${where}: a condition must be an object.`); return undefined; }
  if (depth >= MAX_COND_DEPTH) { errors.push(`${where}: conditions are nested too deeply.`); return undefined; }
  const keys = Object.keys(cond);
  if (keys.length !== 1 && !("path" in cond)) { errors.push(`${where}: a condition needs exactly one of all/any/not or a path+op.`); return undefined; }
  if ("all" in cond || "any" in cond) {
    const k = "all" in cond ? "all" : "any";
    rejectUnknownKeys(cond, [k], where, errors);
    if (!Array.isArray(cond[k]) || cond[k].length === 0 || cond[k].length > MAX_COND_ITEMS) { errors.push(`${where}.${k}: needs 1-${MAX_COND_ITEMS} conditions.`); return undefined; }
    return { [k]: cond[k].map((c, i) => checkCondition(c, `${where}.${k}[${i}]`, errors, depth + 1)).filter(Boolean) };
  }
  if ("not" in cond) {
    rejectUnknownKeys(cond, ["not"], where, errors);
    return { not: checkCondition(cond.not, `${where}.not`, errors, depth + 1) };
  }
  rejectUnknownKeys(cond, ["path", "op", "value"], where, errors);
  const path = checkPath(cond.path, `${where}.path`, errors);
  if (!CONDITION_OPS.includes(cond.op)) { errors.push(`${where}.op: "${cond.op}" is not an allowed operator.`); return undefined; }
  const out = { path, op: cond.op };
  if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(cond.op)) {
    if (!["string", "number", "boolean"].includes(typeof cond.value)) errors.push(`${where}.value: must be a string, number or boolean.`);
    else out.value = typeof cond.value === "string" ? checkString(cond.value, `${where}.value`, errors) : cond.value;
  }
  if (cond.op === "in") {
    if (!Array.isArray(cond.value) || cond.value.length === 0 || cond.value.length > 16 || cond.value.some((v) => !["string", "number"].includes(typeof v))) errors.push(`${where}.value: "in" needs a list of 1-16 strings or numbers.`);
    else out.value = cond.value.map((v) => (typeof v === "string" ? v.slice(0, MAX_STRING) : v));
  }
  return out;
}

function pickWhen(block, where, errors, target) {
  if (block.when !== undefined) { const c = checkCondition(block.when, `${where}.when`, errors); if (c) target.when = c; }
}

function validateField(f, where, errors) {
  if (!isPlainObject(f)) { errors.push(`${where}: must be an object.`); return null; }
  rejectUnknownKeys(f, KEYSETS.field, where, errors);
  const out = { labelKey: checkLabelKey(f.labelKey, `${where}.labelKey`, errors, { required: true }), value: checkTemplateString(f.value, `${where}.value`, errors) };
  if (out.value === undefined) errors.push(`${where}.value: is required.`);
  const fmt = checkFormat(f.format, `${where}.format`, errors); if (fmt) out.format = fmt;
  pickWhen(f, where, errors, out);
  return out;
}

function validateBlock(b, i, errors) {
  const where = `blocks[${i}]`;
  if (!isPlainObject(b)) { errors.push(`${where}: must be an object.`); return null; }
  if (!BLOCK_TYPES.includes(b.type)) { errors.push(`${where}: unknown block type "${String(b.type).slice(0, 30)}".`); return null; }
  rejectUnknownKeys(b, KEYSETS[b.type], where, errors);
  const out = { type: b.type };
  pickWhen(b, where, errors, out);

  switch (b.type) {
    case "header": {
      out.titleLabel = checkLabelKey(b.titleLabel, `${where}.titleLabel`, errors, { required: true });
      for (const k of ["showLogo", "showOrgAddress", "showTaxId"]) if (b[k] !== undefined) { if (typeof b[k] !== "boolean") errors.push(`${where}.${k}: must be true/false.`); else out[k] = b[k]; }
      if (b.fields !== undefined) {
        if (!Array.isArray(b.fields) || b.fields.length > MAX_FIELDS) errors.push(`${where}.fields: at most ${MAX_FIELDS} fields.`);
        else out.fields = b.fields.map((f, j) => validateField(f, `${where}.fields[${j}]`, errors)).filter(Boolean);
      }
      break;
    }
    case "parties": {
      if (!Array.isArray(b.columns) || b.columns.length === 0 || b.columns.length > 3) { errors.push(`${where}.columns: needs 1-3 columns.`); break; }
      out.columns = b.columns.map((c, j) => {
        const w = `${where}.columns[${j}]`;
        if (!isPlainObject(c)) { errors.push(`${w}: must be an object.`); return null; }
        rejectUnknownKeys(c, KEYSETS.partyColumn, w, errors);
        const col = { titleLabel: checkLabelKey(c.titleLabel, `${w}.titleLabel`, errors, { required: true }) };
        if (!Array.isArray(c.lines) || c.lines.length === 0 || c.lines.length > 12) errors.push(`${w}.lines: needs 1-12 lines.`);
        else col.lines = c.lines.map((l, k) => checkTemplateString(l, `${w}.lines[${k}]`, errors) ?? "");
        pickWhen(c, w, errors, col);
        return col;
      }).filter(Boolean);
      break;
    }
    case "meta": {
      out.titleLabel = checkLabelKey(b.titleLabel, `${where}.titleLabel`, errors);
      if (!Array.isArray(b.fields) || b.fields.length === 0 || b.fields.length > MAX_FIELDS) { errors.push(`${where}.fields: needs 1-${MAX_FIELDS} fields.`); break; }
      out.fields = b.fields.map((f, j) => validateField(f, `${where}.fields[${j}]`, errors)).filter(Boolean);
      if (b.columns !== undefined) { if (![1, 2, 3].includes(b.columns)) errors.push(`${where}.columns: must be 1, 2 or 3.`); else out.columns = b.columns; }
      break;
    }
    case "table": {
      out.titleLabel = checkLabelKey(b.titleLabel, `${where}.titleLabel`, errors);
      if (!TABLE_SOURCES[b.source]) { errors.push(`${where}.source: must be one of ${Object.keys(TABLE_SOURCES).join(", ")}.`); break; }
      out.source = b.source;
      if (!Array.isArray(b.columns) || b.columns.length === 0 || b.columns.length > MAX_COLUMNS) { errors.push(`${where}.columns: needs 1-${MAX_COLUMNS} columns.`); break; }
      out.columns = b.columns.map((c, j) => {
        const w = `${where}.columns[${j}]`;
        if (!isPlainObject(c)) { errors.push(`${w}: must be an object.`); return null; }
        rejectUnknownKeys(c, KEYSETS.column, w, errors);
        if (!TABLE_SOURCES[b.source].includes(c.key)) errors.push(`${w}.key: "${c.key}" is not a column of ${b.source}.`);
        const col = { key: c.key, labelKey: checkLabelKey(c.labelKey, `${w}.labelKey`, errors, { required: true }) };
        const fmt = checkFormat(c.format, `${w}.format`, errors); if (fmt) col.format = fmt;
        if (c.width !== undefined) { if (typeof c.width !== "number" || c.width < 1 || c.width > 100) errors.push(`${w}.width: must be 1-100.`); else col.width = c.width; }
        if (c.align !== undefined) { if (!["start", "end", "center"].includes(c.align)) errors.push(`${w}.align: must be start, end or center.`); else col.align = c.align; }
        return col;
      }).filter(Boolean);
      if (b.repeatHeader !== undefined) { if (typeof b.repeatHeader !== "boolean") errors.push(`${where}.repeatHeader: must be true/false.`); else out.repeatHeader = b.repeatHeader; }
      if (b.emptyText !== undefined) out.emptyText = checkString(b.emptyText, `${where}.emptyText`, errors);
      break;
    }
    case "totals": {
      if (!Array.isArray(b.rows) || b.rows.length === 0 || b.rows.length > MAX_FIELDS) { errors.push(`${where}.rows: needs 1-${MAX_FIELDS} rows.`); break; }
      out.rows = b.rows.map((r, j) => {
        const w = `${where}.rows[${j}]`;
        if (!isPlainObject(r)) { errors.push(`${w}: must be an object.`); return null; }
        rejectUnknownKeys(r, KEYSETS.totalRow, w, errors);
        const row = { labelKey: checkLabelKey(r.labelKey, `${w}.labelKey`, errors, { required: true }), path: checkPath(r.path, `${w}.path`, errors) };
        const fmt = checkFormat(r.format, `${w}.format`, errors); row.format = fmt || "currency";
        for (const k of ["negate", "emphasize"]) if (r[k] !== undefined) { if (typeof r[k] !== "boolean") errors.push(`${w}.${k}: must be true/false.`); else row[k] = r[k]; }
        pickWhen(r, w, errors, row);
        return row;
      }).filter(Boolean);
      break;
    }
    case "text": {
      out.titleLabel = checkLabelKey(b.titleLabel, `${where}.titleLabel`, errors);
      out.text = checkTemplateString(b.text, `${where}.text`, errors);
      if (out.text === undefined) errors.push(`${where}.text: is required.`);
      if (b.size !== undefined) { if (typeof b.size !== "number" || b.size < 6 || b.size > 24) errors.push(`${where}.size: must be 6-24.`); else out.size = b.size; }
      if (b.muted !== undefined) { if (typeof b.muted !== "boolean") errors.push(`${where}.muted: must be true/false.`); else out.muted = b.muted; }
      break;
    }
    case "signature": {
      if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > 4) { errors.push(`${where}.lines: needs 1-4 signature lines.`); break; }
      out.lines = b.lines.map((l, j) => {
        const w = `${where}.lines[${j}]`;
        if (!isPlainObject(l)) { errors.push(`${w}: must be an object.`); return null; }
        rejectUnknownKeys(l, KEYSETS.sigLine, w, errors);
        const line = { labelKey: checkLabelKey(l.labelKey, `${w}.labelKey`, errors, { required: true }) };
        if (l.path !== undefined) line.path = checkPath(l.path, `${w}.path`, errors);
        return line;
      }).filter(Boolean);
      break;
    }
    case "spacer": {
      if (typeof b.height !== "number" || b.height < 2 || b.height > 120) errors.push(`${where}.height: must be 2-120.`); else out.height = b.height;
      break;
    }
    default: break; // approval, divider carry no other fields
  }
  return out;
}

/**
 * Validates and normalizes a template spec. Returns
 * { valid, errors, spec, specHash } -- `spec` is rebuilt from allowlisted
 * keys only, so nothing the caller smuggled in survives.
 */
export function validateTemplateSpec(input, { expectedType } = {}) {
  const errors = [];
  if (!isPlainObject(input)) return { valid: false, errors: ["A template must be a JSON object."], spec: null, specHash: null };
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(input), "utf8"); } catch { return { valid: false, errors: ["Template is not serializable."], spec: null, specHash: null }; }
  if (size > MAX_SPEC_BYTES) return { valid: false, errors: [`Template exceeds ${MAX_SPEC_BYTES} bytes.`], spec: null, specHash: null };

  rejectUnknownKeys(input, KEYSETS.root, "template", errors);
  if (input.schema !== TEMPLATE_SCHEMA_ID) errors.push(`schema must be "${TEMPLATE_SCHEMA_ID}".`);
  if (!DOCUMENT_TYPES.includes(input.documentType)) errors.push(`documentType must be one of ${DOCUMENT_TYPES.join(", ")}.`);
  if (expectedType && input.documentType !== expectedType) errors.push(`documentType must be "${expectedType}" for this template.`);

  const spec = { schema: TEMPLATE_SCHEMA_ID, documentType: input.documentType };
  spec.name = checkString(input.name, "name", errors, { max: 120, required: true });
  if (input.description !== undefined) spec.description = checkString(input.description, "description", errors, { max: 500 });
  if (input.locale !== undefined) {
    const loc = normalizeLocale(input.locale);
    if (!loc) errors.push(`locale must be one of ${SUPPORTED_LOCALES.join(", ")}.`); else spec.locale = loc;
  }

  if (input.page !== undefined) {
    if (!isPlainObject(input.page)) errors.push("page: must be an object.");
    else {
      rejectUnknownKeys(input.page, KEYSETS.page, "page", errors);
      spec.page = {};
      if (input.page.size !== undefined) { if (!["A4", "LETTER"].includes(input.page.size)) errors.push('page.size must be "A4" or "LETTER".'); else spec.page.size = input.page.size; }
      if (input.page.orientation !== undefined) { if (!["portrait", "landscape"].includes(input.page.orientation)) errors.push("page.orientation must be portrait or landscape."); else spec.page.orientation = input.page.orientation; }
      if (input.page.margins !== undefined) {
        if (!isPlainObject(input.page.margins)) errors.push("page.margins: must be an object.");
        else {
          rejectUnknownKeys(input.page.margins, KEYSETS.margins, "page.margins", errors);
          spec.page.margins = {};
          for (const side of KEYSETS.margins) {
            const v = input.page.margins[side];
            if (v === undefined) continue;
            if (typeof v !== "number" || v < 20 || v > 120) errors.push(`page.margins.${side} must be 20-120 points.`); else spec.page.margins[side] = v;
          }
        }
      }
    }
  }

  if (input.style !== undefined) {
    if (!isPlainObject(input.style)) errors.push("style: must be an object.");
    else {
      rejectUnknownKeys(input.style, KEYSETS.style, "style", errors);
      spec.style = {};
      if (input.style.accentColor !== undefined) { if (typeof input.style.accentColor !== "string" || !HEX_RE.test(input.style.accentColor)) errors.push("style.accentColor must be a #RRGGBB color."); else spec.style.accentColor = input.style.accentColor; }
      if (input.style.fontScale !== undefined) { if (typeof input.style.fontScale !== "number" || input.style.fontScale < 0.8 || input.style.fontScale > 1.3) errors.push("style.fontScale must be 0.8-1.3."); else spec.style.fontScale = input.style.fontScale; }
      if (input.style.showLogo !== undefined) { if (typeof input.style.showLogo !== "boolean") errors.push("style.showLogo must be true/false."); else spec.style.showLogo = input.style.showLogo; }
    }
  }

  if (input.numbering !== undefined) {
    if (!isPlainObject(input.numbering)) errors.push("numbering: must be an object.");
    else {
      rejectUnknownKeys(input.numbering, KEYSETS.numbering, "numbering", errors);
      spec.numbering = {};
      if (input.numbering.prefix !== undefined) { if (typeof input.numbering.prefix !== "string" || !/^[A-Z0-9]{1,8}$/.test(input.numbering.prefix)) errors.push("numbering.prefix must be 1-8 uppercase letters/digits."); else spec.numbering.prefix = input.numbering.prefix; }
      if (input.numbering.fiscalYearReset !== undefined) { if (typeof input.numbering.fiscalYearReset !== "boolean") errors.push("numbering.fiscalYearReset must be true/false."); else spec.numbering.fiscalYearReset = input.numbering.fiscalYearReset; }
    }
  }

  // Currency configuration (section 5 metadata): how the symbol is shown, and
  // optionally which currencies this template is designed for.
  if (input.currency !== undefined) {
    if (!isPlainObject(input.currency)) errors.push("currency: must be an object.");
    else {
      rejectUnknownKeys(input.currency, KEYSETS.currency, "currency", errors);
      spec.currency = {};
      if (input.currency.display !== undefined) { if (!["symbol", "narrowSymbol", "code", "name"].includes(input.currency.display)) errors.push("currency.display must be symbol, narrowSymbol, code or name."); else spec.currency.display = input.currency.display; }
      if (input.currency.allowed !== undefined) {
        if (!Array.isArray(input.currency.allowed) || input.currency.allowed.length === 0 || input.currency.allowed.length > 10 || input.currency.allowed.some((c) => !/^[A-Z]{3}$/.test(c))) errors.push("currency.allowed must be a list of 1-10 ISO currency codes.");
        else spec.currency.allowed = input.currency.allowed;
      }
    }
  }

  if (input.requiredSources !== undefined) {
    if (!Array.isArray(input.requiredSources) || input.requiredSources.length > 8 || input.requiredSources.some((s) => typeof s !== "string" || !/^[a-z_]{2,32}$/.test(s))) errors.push("requiredSources must be a list of up to 8 short identifiers.");
    else spec.requiredSources = input.requiredSources;
  }

  if (!Array.isArray(input.blocks) || input.blocks.length === 0) errors.push("blocks: a template needs at least one block.");
  else if (input.blocks.length > MAX_BLOCKS) errors.push(`blocks: at most ${MAX_BLOCKS} blocks.`);
  else spec.blocks = input.blocks.map((b, i) => validateBlock(b, i, errors)).filter(Boolean);

  if (input.footer !== undefined) {
    if (!isPlainObject(input.footer)) errors.push("footer: must be an object.");
    else {
      rejectUnknownKeys(input.footer, KEYSETS.footer, "footer", errors);
      spec.footer = {};
      if (input.footer.text !== undefined) spec.footer.text = checkTemplateString(input.footer.text, "footer.text", errors);
      for (const k of ["pageNumbers", "showDocumentId", "showHash", "showVerify"]) if (input.footer[k] !== undefined) { if (typeof input.footer[k] !== "boolean") errors.push(`footer.${k} must be true/false.`); else spec.footer[k] = input.footer[k]; }
    }
  }

  if (errors.length > 0) return { valid: false, errors, spec: null, specHash: null };
  const clean = jsonSafe(spec);
  return { valid: true, errors: [], spec: clean, specHash: canonicalHash(clean) };
}

// ---------------------------------------------------------------------
// Runtime helpers -- used by the renderer. None of these evaluate code.
// ---------------------------------------------------------------------

export function getPath(view, path) {
  if (typeof path !== "string" || !PATH_RE.test(path)) return undefined;
  let cur = view;
  for (const seg of path.split(".")) {
    if (BANNED_SEGMENTS.has(seg) || cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function evalCondition(cond, view) {
  if (!cond) return true;
  if (cond.all) return cond.all.every((c) => evalCondition(c, view));
  if (cond.any) return cond.any.some((c) => evalCondition(c, view));
  if (cond.not) return !evalCondition(cond.not, view);
  const v = getPath(view, cond.path);
  switch (cond.op) {
    case "exists": return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
    case "notExists": return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    case "truthy": return !!v;
    case "falsy": return !v;
    case "eq": return v === cond.value;
    case "neq": return v !== cond.value;
    case "gt": return typeof v === "number" && v > cond.value;
    case "gte": return typeof v === "number" && v >= cond.value;
    case "lt": return typeof v === "number" && v < cond.value;
    case "lte": return typeof v === "number" && v <= cond.value;
    case "in": return Array.isArray(cond.value) && cond.value.includes(v);
    default: return false;
  }
}

export function collectReferencedPaths(spec) {
  const found = new Set();
  const scan = (s) => { if (typeof s === "string") for (const m of s.matchAll(INTERP_RE)) found.add(m[1]); };
  const scanCond = (c) => { if (!c) return; if (c.path) found.add(c.path); (c.all || c.any || []).forEach(scanCond); if (c.not) scanCond(c.not); };
  for (const b of spec.blocks || []) {
    scanCond(b.when);
    (b.fields || []).forEach((f) => { scan(f.value); scanCond(f.when); });
    (b.columns || []).forEach((c) => { (c.lines || []).forEach(scan); scanCond(c.when); });
    (b.rows || []).forEach((r) => { if (r.path) found.add(r.path); scanCond(r.when); });
    (b.lines || []).forEach((l) => { if (l.path) found.add(l.path); });
    scan(b.text);
  }
  scan(spec.footer?.text);
  return [...found];
}

export { INTERP_RE };
