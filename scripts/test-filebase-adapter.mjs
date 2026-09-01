// scripts/test-filebase-adapter.mjs
// One-off: confirm the Filebase adapter (pin/fetchReplica/getPinStatus) works against real,
// live credentials before running the full backup pipeline against it.
// Run with: node scripts/test-filebase-adapter.mjs

import dotenv from "dotenv";
import { pathToFileURL } from "node:url";

const ROOT = "D:/Codespace-blank/codespaces-blank-main/codespaces-blank-main";
dotenv.config({ path: `${ROOT}/inaya-network-dapp/.env.local` });

const toUrl = (p) => pathToFileURL(p).href;
const filebase = await import(toUrl(`${ROOT}/inaya-network-dapp/src/lib/pinningProviders/filebase.js`));

async function main() {
  console.log("isConfigured:", filebase.isConfigured());

  const content = `Filebase adapter test at ${new Date().toISOString()}`;
  console.log("\nStep 1: pin real content");
  const result = await filebase.pin(content, { name: `adapter_test_${Date.now()}` });
  console.log(JSON.stringify(result, null, 2));

  console.log("\nStep 2: fetch it back");
  const fetched = await filebase.fetchReplica(result.providerRef);
  console.log("match:", fetched === content);

  console.log("\nStep 3: check pin status");
  const status = await filebase.getPinStatus(result.providerRef);
  console.log("status:", status);

  console.log("\nStep 4: check pin status for a nonexistent key (should be false)");
  const missingStatus = await filebase.getPinStatus("this-key-does-not-exist-12345");
  console.log("missingStatus:", missingStatus);

  console.log(fetched === content && status === true && missingStatus === false ? "\nPASS" : "\nFAIL");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
