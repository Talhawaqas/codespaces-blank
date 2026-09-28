// src/lib/ssrfSafeFetch.js
//
// Security hardening pass (September 2026). A drop-in, SSRF-safe replacement for `fetch()` for
// any place this app makes a server-side request to a URL an ORG configured, rather than a URL
// this codebase hardcoded itself. Reuses the exact validation this app already proved out in
// workflows/http.js (isPrivateAddress, the metadata-host blocklist, and a custom DNS lookup that
// blocks a hostname whose resolved address is private -- closing the classic "the hostname looks
// public at validation time, then DNS-rebinds to 169.254.169.254 at request time" bypass), rather
// than inventing a second implementation of the same checks.
//
// Found by this security pass: src/lib/integrationProviders/genericOidc.js makes FOUR sequential
// server-side fetches to URLs that ultimately come from an org-supplied "issuer" (its own
// discovery document, then whatever authorization/token/userinfo/revocation endpoints THAT
// document names) with zero validation -- a malicious or compromised org's OIDC configuration
// could point any of those at an internal service, a cloud metadata endpoint, or a redirect chain
// ending at one, and have the response partially reflected back through this app's own error
// messages. This module is the fix for that class of bug, used wherever else the same shape shows
// up (an org- or user-supplied URL that this server must itself fetch).

import https from "node:https";
import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { isPrivateAddress, hostAllowed } from "./workflows/http.js";

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data", "169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

function testLocalAllowed() {
  return process.env.SSRF_SAFE_FETCH_ALLOW_LOCAL === "1" && process.env.NODE_ENV !== "production" && !process.env.VERCEL;
}

/** Static checks on the URL itself (no DNS yet). Throws a safe, generic Error on any violation --
 *  never echoes back exactly which rule tripped in a way that helps an attacker map internal
 *  network topology by trial and error. */
export function assertPublicHttpsUrl(rawUrl, { allowedHosts = null } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error("Not a valid URL."); }
  const testLocal = testLocalAllowed();
  if (u.protocol !== "https:" && !(testLocal && u.protocol === "http:")) throw new Error("Only https URLs are allowed.");
  if (u.username || u.password) throw new Error("Credentials must not be embedded in the URL.");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_HOSTS.has(host)) throw new Error("This host is not reachable.");
  if (!testLocal) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) throw new Error("This host is not reachable.");
    if (net.isIP(host) && isPrivateAddress(host)) throw new Error("This host is not reachable.");
  }
  if (allowedHosts && !hostAllowed(host, allowedHosts)) throw new Error("This host is not in the allowed list.");
  return u;
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    if (!testLocalAllowed() && (!list.length || list.some((a) => isPrivateAddress(a.address)))) return cb(Object.assign(new Error("This host is not reachable."), { code: "SSRF_BLOCKED" }));
    if (options?.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

function rawRequest(u, { method, headers, body, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({ protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || undefined, path: `${u.pathname}${u.search}`, method, headers, lookup: safeLookup, timeout: timeoutMs, agent: false }, (res) => {
      const chunks = []; let size = 0; let destroyed = false;
      res.on("data", (c) => { size += c.length; if (size > maxBytes) { destroyed = true; req.destroy(Object.assign(new Error("The response is larger than the allowed size."), { code: "RESPONSE_TOO_LARGE" })); return; } chunks.push(c); });
      res.on("end", () => { if (!destroyed) resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }); });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("The request timed out."), { code: "TIMEOUT" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * SSRF-safe fetch for a URL this app did not itself choose. Mimics the small slice of the `fetch()`
 * Response interface this codebase actually uses: { ok, status, json(), text() }. Redirects are
 * NEVER followed (a 3xx is returned to the caller as-is, since blindly following one is exactly how
 * a validated-safe URL ends up fetching a private one) -- a caller that needs to follow a redirect
 * must re-validate the Location header itself and call this function again.
 */
export async function ssrfSafeFetch(rawUrl, { method = "GET", headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, allowedHosts = null } = {}) {
  const u = assertPublicHttpsUrl(rawUrl, { allowedHosts });
  const res = await rawRequest(u, { method, headers, body, timeoutMs: Math.min(timeoutMs, 30000), maxBytes: Math.min(maxBytes, 4 * 1024 * 1024) });
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: res.headers,
    text: async () => res.body,
    json: async () => JSON.parse(res.body),
  };
}
