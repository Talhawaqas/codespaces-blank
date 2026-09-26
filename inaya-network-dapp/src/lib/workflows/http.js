// src/lib/workflows/http.js
//
// SOW §10: a controlled HTTP/API connector. Not a general-purpose fetch: it
// exists so a workflow can read from / write to an approved external system
// (for example the organization's helpdesk) without becoming an SSRF gadget.
//
// Controls, all enforced here and never delegated to the workflow author:
//   - https only (plain http exists solely for local automated tests, behind an
//     env flag that is refused in production/Vercel);
//   - an explicit host allowlist on the node, and the credential's own host scope;
//   - private / loopback / link-local / metadata addresses blocked, checked on
//     EVERY connection through a custom DNS lookup (defeats DNS rebinding), and
//     redirects are not followed (a redirect could point somewhere private);
//   - method limits (DELETE only when the node AND the organization policy allow);
//   - request/response size caps, connect+total timeout, per-execution call budget;
//   - credentials come from credential references and are scrubbed from output.

import https from "node:https";
import http from "node:http";
import dns from "node:dns";
import net from "node:net";
import { renderTemplate } from "./expr.js";
import { resolveCredential } from "./credentials.js";
import { redact } from "./common.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_RESPONSE = 512 * 1024;

export function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = String(addr).toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fec0");
}

/** Local-test escape hatch. Never active in production or on Vercel. */
export function localTestHostsAllowed() {
  return process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL === "1" && process.env.NODE_ENV !== "production" && !process.env.VERCEL;
}

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data", "169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);

export function hostAllowed(host, allowedHosts) {
  const h = String(host).toLowerCase();
  return (allowedHosts || []).some((pat) => {
    const p = String(pat).toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

/** Static URL checks (no DNS). Throws an Error with a safe message. */
export function assertUrlAllowed(rawUrl, allowedHosts) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error("The URL is not valid."); }
  const testLocal = localTestHostsAllowed();
  if (u.protocol !== "https:" && !(testLocal && u.protocol === "http:")) throw new Error("Only https URLs are allowed.");
  if (u.username || u.password) throw new Error("Credentials must not be embedded in the URL.");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_HOSTS.has(host)) throw new Error("Cloud metadata endpoints are blocked.");
  if (!testLocal) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) throw new Error("Local and internal host names are blocked.");
    if (net.isIP(host) && isPrivateAddress(host)) throw new Error("Private, loopback and link-local addresses are blocked.");
  }
  if (!hostAllowed(host, allowedHosts)) throw new Error(`The host "${host}" is not in this node's allowed hosts.`);
  const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
  if (!testLocal && ![443, 8443].includes(port)) throw new Error("Only ports 443 and 8443 are allowed.");
  return u;
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    if (!localTestHostsAllowed() && (!list.length || list.some((a) => isPrivateAddress(a.address)))) return cb(Object.assign(new Error("The host resolves to a private address."), { code: "SSRF_BLOCKED" }));
    if (options?.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

function rawRequest(u, { method, headers, body, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({ protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || undefined, path: `${u.pathname}${u.search}`, method, headers, lookup: safeLookup, timeout: timeoutMs, agent: false }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > maxBytes) { req.destroy(Object.assign(new Error("The response is larger than the allowed size."), { code: "RESPONSE_TOO_LARGE" })); return; } chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error(`The request timed out after ${timeoutMs} ms.`), { code: "TIMEOUT" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function pickPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const seg of String(path).split(".")) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[seg]; }
  return cur;
}

/**
 * Runs one HTTP node. `ctx` = { orgId, executionId, nodeKey, actorEmail, scope, settings, budget, secrets }.
 * Returns { output, meta }. Throws Error (with .retryable) on failure.
 */
export async function runHttpRequest(config, ctx) {
  const { orgId, executionId, nodeKey, actorEmail, scope, settings, budget, secrets } = ctx;
  if (budget) { budget.http = (budget.http || 0) + 1; if (budget.http > (settings?.limits?.maxHttpCalls ?? 20)) throw Object.assign(new Error("The execution's HTTP request budget is used up."), { retryable: false, code: "BUDGET" }); }
  const method = (config.method || "GET").toUpperCase();
  if (method === "DELETE" && !(config.allowDelete === true && settings?.allowHttpDelete === true)) throw Object.assign(new Error("DELETE requests are not permitted by policy."), { retryable: false, code: "POLICY" });
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw Object.assign(new Error("Unsupported method."), { retryable: false });

  const rendered = renderTemplate(String(config.url), scope);
  let u;
  try { u = assertUrlAllowed(rendered, config.allowedHosts); } catch (e) { throw Object.assign(e, { retryable: false, code: "SSRF_BLOCKED" }); }
  for (const [k, v] of Object.entries(config.query || {})) u.searchParams.set(k, renderTemplate(String(v), scope));

  const headers = { accept: "application/json, text/plain;q=0.8", "user-agent": "InayaWorkflow/1.0" };
  for (const [k, v] of Object.entries(config.headers || {})) {
    if (/^(host|content-length|transfer-encoding|connection|authorization|cookie)$/i.test(k)) continue; // credentials only via a credential reference
    headers[k.toLowerCase()] = renderTemplate(String(v), scope);
  }
  if (config.credentialId) {
    const cred = await resolveCredential({ orgId, credentialId: config.credentialId, host: u.hostname, providerWanted: ["http_bearer", "http_header", "http_basic"], executionId, nodeKey, actorEmail });
    if (cred.error) throw Object.assign(new Error(cred.error), { retryable: false, code: cred.reasonCode || "CREDENTIAL" });
    if (cred.provider === "http_bearer") { headers.authorization = `Bearer ${cred.secret.token}`; secrets?.add(cred.secret.token); }
    else if (cred.provider === "http_header") { headers[String(cred.secret.headerName).toLowerCase()] = cred.secret.value; secrets?.add(cred.secret.value); }
    else { const b = Buffer.from(`${cred.secret.username}:${cred.secret.password}`).toString("base64"); headers.authorization = `Basic ${b}`; secrets?.add(b); secrets?.add(cred.secret.password); }
  }
  let body = null;
  if (method !== "GET" && config.body !== undefined) {
    body = typeof config.body === "string" ? renderTemplate(config.body, scope) : JSON.stringify(JSON.parse(renderTemplate(JSON.stringify(config.body), scope)));
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw Object.assign(new Error("The request body is too large."), { retryable: false });
    headers["content-type"] = headers["content-type"] || "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
    if (config.retryMutating) headers["idempotency-key"] = `${executionId}:${nodeKey}`;
  }

  const timeoutMs = Math.min(config.timeoutMs || 10000, 30000);
  const maxBytes = Math.min(config.maxResponseBytes || DEFAULT_MAX_RESPONSE, 2 * 1024 * 1024);
  const started = Date.now();
  let res;
  try { res = await rawRequest(u, { method, headers, body, timeoutMs, maxBytes }); } catch (e) {
    const blocked = e.code === "SSRF_BLOCKED" || e.code === "RESPONSE_TOO_LARGE";
    throw Object.assign(new Error(`HTTP request failed: ${redact(e.message, { secrets: [...(secrets || [])] })}`), { retryable: !blocked && (method === "GET" || config.retryMutating === true), code: e.code || "NETWORK" });
  }
  const durationMs = Date.now() - started;
  if (res.status >= 300 && res.status < 400) throw Object.assign(new Error(`The server answered with a redirect (${res.status}); redirects are not followed.`), { retryable: false, code: "REDIRECT" });
  if (res.status >= 400) throw Object.assign(new Error(`The server answered ${res.status}.`), { retryable: res.status >= 500 && (method === "GET" || config.retryMutating === true), code: `HTTP_${res.status}` });

  let data = res.body;
  if (/json/i.test(res.headers["content-type"] || "") || /^[\s]*[\[{]/.test(res.body)) { try { data = JSON.parse(res.body); } catch { /* keep text */ } }
  const scrub = (v) => redact(v, { secrets: [...(secrets || [])] });
  let output = pickPath(data, config.rowsPath);
  if (Array.isArray(output) && Array.isArray(config.select) && config.select.length) output = output.map((r) => Object.fromEntries(config.select.filter((f) => r && f in r).map((f) => [f, r[f]])));
  if (Array.isArray(output)) output = output.slice(0, 500);
  return { output: scrub(output === undefined ? data : output), meta: { status: res.status, durationMs, host: u.hostname, method, bytes: Buffer.byteLength(res.body) } };
}
