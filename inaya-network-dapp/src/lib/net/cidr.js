// src/lib/net/cidr.js
//
// Small, dependency-free IPv4/IPv6 address and CIDR matching for access policy (share links, DLP, device policy). Pure functions.
// An unparseable address or CIDR never matches (fail closed): a policy that lists "10.0.0.0/8" allows only addresses that
// parse as inside it.

/** Normalizes an address string: trims, strips a zone id and brackets, unwraps IPv4-mapped IPv6 (::ffff:1.2.3.4). */
export function normalizeIp(raw) {
  let s = String(raw ?? "").trim().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%"); if (zone >= 0) s = s.slice(0, zone);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s); if (m) s = m[1];
  return s.toLowerCase();
}

function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts.reduce((acc, n) => acc * 256n + BigInt(n), 0n);
}

function parseV6(s) {
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(":")) return null;
  let head = s; let tail = "";
  if (s.includes("::")) { const [h, t, extra] = s.split("::"); if (extra !== undefined) return null; head = h; tail = t; }
  const toGroups = (str) => (str === "" ? [] : str.split(":"));
  const expandV4 = (groups) => {
    const last = groups[groups.length - 1];
    if (last && last.includes(".")) { const v = parseV4(last); if (v === null) return null; return [...groups.slice(0, -1), ((v >> 16n) & 0xffffn).toString(16), (v & 0xffffn).toString(16)]; }
    return groups;
  };
  const h = expandV4(toGroups(head)); const t = expandV4(toGroups(tail));
  if (!h || !t) return null;
  const missing = 8 - (h.length + t.length);
  if (s.includes("::") ? missing < 1 : missing !== 0) return null;
  const groups = [...h, ...Array(s.includes("::") ? missing : 0).fill("0"), ...t];
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) { if (!/^[0-9a-f]{1,4}$/i.test(g)) return null; v = (v << 16n) + BigInt(parseInt(g, 16)); }
  return v;
}

/** { version: 4|6, value: BigInt } or null */
export function parseIp(raw) {
  const s = normalizeIp(raw);
  const v4 = parseV4(s); if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseV6(s); if (v6 !== null) return { version: 6, value: v6 };
  return null;
}

/** "1.2.3.4/24", "2001:db8::/32" or a bare address (host route). Returns null when malformed. */
export function parseCidr(raw) {
  const [addr, bitsRaw, extra] = String(raw ?? "").trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(addr); if (!ip) return null;
  const max = ip.version === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? max : /^\d{1,3}$/.test(bitsRaw) ? Number(bitsRaw) : -1;
  if (bits < 0 || bits > max) return null;
  const shift = BigInt(max - bits);
  return { version: ip.version, bits, network: (ip.value >> shift) << shift, shift };
}

export function ipInCidr(ip, cidr) {
  const a = parseIp(ip); const c = typeof cidr === "string" ? parseCidr(cidr) : cidr;
  if (!a || !c || a.version !== c.version) return false;
  return (a.value >> c.shift) << c.shift === c.network;
}

/** True when `ip` is inside any entry of `list`. An empty or absent list means "no restriction" for the caller to decide. */
export function ipMatchesAny(ip, list) {
  return (list || []).some((c) => ipInCidr(ip, c));
}

export const isValidCidr = (raw) => parseCidr(raw) !== null;
