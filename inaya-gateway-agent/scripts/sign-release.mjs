#!/usr/bin/env node
// scripts/sign-release.mjs -- build and sign an upgrade bundle.
//   node scripts/sign-release.mjs keygen                              prints a new release key pair (keep the private key offline; give the PUBLIC key to gateways)
//   node scripts/sign-release.mjs sign <version> <privateKey.pem>    bundles ./src and ./bin into release-<version>.json and prints the manifest
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { signManifest } from "../src/upgrade.js";

const [cmd, version, keyFile] = process.argv.slice(2);
if (cmd === "keygen") { const { publicKey, privateKey } = generateKeyPairSync("ed25519"); console.log(JSON.stringify({ publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) }, null, 2)); }
else if (cmd === "sign" && version && keyFile) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), ".."); const files = {};
  for (const d of ["src"]) for (const f of fs.readdirSync(path.join(root, d))) if (f.endsWith(".js")) files[`${d}/${f}`] = fs.readFileSync(path.join(root, d, f)).toString("base64");
  const bytes = Buffer.from(JSON.stringify({ version, files })); fs.writeFileSync(`release-${version}.json`, bytes); console.log(JSON.stringify(signManifest({ version, bytes, privateKeyPem: fs.readFileSync(keyFile, "utf8") }), null, 2));
} else { console.error("Usage: keygen | sign <version> <privateKey.pem>"); process.exit(1); }
