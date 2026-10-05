// src/config.js -- the agent's local state, encrypted at rest. It holds the gateway's private key and the data key that wraps file keys, so both are protected
// by a passphrase the operator supplies (INAYA_GATEWAY_PASSPHRASE or a prompt): AES-256-GCM under a scrypt-derived key, file mode 0600. Without the passphrase
// the file is useless. Nothing in it is ever sent to Inaya.
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const defaultDir = () => process.env.INAYA_GATEWAY_HOME || path.join(process.env.PROGRAMDATA || process.env.HOME || ".", ".inaya-gateway");
const KDF = { N: 2 ** 15, r: 8, p: 1 };

export function encryptConfig(obj, passphrase) {
  if (!passphrase || passphrase.length < 8) throw new Error("A passphrase of at least 8 characters is required to protect the gateway's keys.");
  const salt = randomBytes(16), iv = randomBytes(12); const key = scryptSync(passphrase, salt, 32, { ...KDF, maxmem: 128 * 1024 * 1024 });
  const c = createCipheriv("aes-256-gcm", key, iv); const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, kdf: "scrypt", ...KDF, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") });
}
export function decryptConfig(text, passphrase) {
  let j; try { j = JSON.parse(text); } catch { throw new Error("The gateway configuration file is not readable."); }
  try {
    const key = scryptSync(passphrase || "", Buffer.from(j.salt, "base64"), 32, { N: j.N, r: j.r, p: j.p, maxmem: 128 * 1024 * 1024 });
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(j.iv, "base64")); d.setAuthTag(Buffer.from(j.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(j.ct, "base64")), d.final()]).toString("utf8"));
  } catch { throw new Error("Wrong passphrase, or the configuration file was changed."); }
}
export function saveConfig(dir, obj, passphrase) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const f = path.join(dir, "gateway.json.enc"); const tmp = f + ".tmp"; fs.writeFileSync(tmp, encryptConfig(obj, passphrase), { mode: 0o600 }); fs.renameSync(tmp, f); return f; }
export function loadConfig(dir, passphrase) { const f = path.join(dir, "gateway.json.enc"); if (!fs.existsSync(f)) return null; return decryptConfig(fs.readFileSync(f, "utf8"), passphrase); }
