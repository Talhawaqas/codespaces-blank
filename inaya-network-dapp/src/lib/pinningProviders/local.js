// src/lib/pinningProviders/local.js
//
// SQA-025: a development / CI pinning provider that stores shards as files in a local directory. It exists so that development, tests and CI keep
// working when the real providers are unavailable -- both were, at once, during this SQA engagement: Pinata returned "plan usage limit" and Filebase
// returned "Free accounts are limited to 500 IPFS pins", and every storage write and every storage test failed with nothing else to fall back to.
//
// It is OPT-IN and never active in production: it reports itself configured only when INAYA_LOCAL_PIN_DIR is set, and never on Vercel (serverless
// functions have no durable disk). It is listed last, so it is only ever used when every real provider has refused. Same interface as the other
// providers: pin, fetchReplica, getPinStatus, unpin, isConfigured.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./hash.js";

export function isConfigured() {
  return Boolean(process.env.INAYA_LOCAL_PIN_DIR) && !process.env.VERCEL;
}

function fileFor(providerRef) {
  const dir = process.env.INAYA_LOCAL_PIN_DIR;
  if (!dir) throw new Error("pinningProviders/local: INAYA_LOCAL_PIN_DIR is not configured.");
  return path.join(dir, createHash("sha256").update(String(providerRef)).digest("hex"));
}

export async function pin(content, { name } = {}) {
  const key = name || `inaya_local_pin_${Date.now()}`;
  const file = fileFor(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return { provider: "local", cid: `local-${sha256Hex(content)}`, providerRef: key, contentHash: sha256Hex(content) };
}

export async function fetchReplica(providerRef) {
  return fs.readFile(fileFor(providerRef), "utf8");
}

export async function getPinStatus(providerRef) {
  try { await fs.access(fileFor(providerRef)); return true; } catch { return false; }
}

export async function unpin(providerRef) {
  try { await fs.unlink(fileFor(providerRef)); } catch (err) { if (err?.code !== "ENOENT") throw err; }
}
