// src/lib/education/identifiers.js
//
// National and student identifiers used by schools in the four target
// markets. Validation is a format check only (length and digits), never a
// claim that the number is real. Aadhaar is never kept in full: Indian
// practice is to store only a masked Aadhaar, so only the last 4 digits are
// accepted and stored.

export const IDENTIFIER_TYPES = {
  b_form: { label: "B-Form / CRC (Pakistan)", country: "PK", pattern: /^\d{13}$/ },
  cnic: { label: "CNIC (Pakistan)", country: "PK", pattern: /^\d{13}$/ },
  aadhaar_last4: { label: "Aadhaar, last 4 digits only (India)", country: "IN", pattern: /^\d{4}$/ },
  apaar: { label: "APAAR ID (India)", country: "IN", pattern: /^\d{12}$/ },
  birth_registration: { label: "Birth Registration Number (Bangladesh)", country: "BD", pattern: /^\d{17}$/ },
  nid_bd: { label: "NID (Bangladesh)", country: "BD", pattern: /^(\d{10}|\d{13}|\d{17})$/ },
  emirates_id: { label: "Emirates ID (UAE)", country: "AE", pattern: /^784\d{12}$/ },
  passport: { label: "Passport", country: null, pattern: /^[A-Z0-9]{6,12}$/ },
  other: { label: "Other", country: null, pattern: /^.{1,40}$/ },
};

export function normalizeIdentifier(type, raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  return type === "passport" || type === "other" ? value.replace(/\s+/g, "") : value.replace(/[\s-]/g, "");
}

/** Returns { identifiers } or { error }. */
export function validateIdentifiers(list) {
  const out = [];
  for (const item of list || []) {
    const def = IDENTIFIER_TYPES[item?.type];
    if (!def) return { error: `Unknown identifier type "${item?.type}".` };
    let value = normalizeIdentifier(item.type, item.value);
    if (item.type === "aadhaar_last4" && /^\d{12}$/.test(value)) value = value.slice(-4); // never keep a full Aadhaar
    if (!def.pattern.test(value)) return { error: `${def.label}: the number doesn't have the expected format.` };
    out.push({ type: item.type, value });
  }
  return { identifiers: out };
}

export function maskValue(value) {
  const v = String(value ?? "");
  if (v.length <= 4) return v;
  return "•".repeat(Math.min(v.length - 4, 8)) + v.slice(-4);
}
