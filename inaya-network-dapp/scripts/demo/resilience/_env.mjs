// scripts/demo/resilience/_env.mjs -- the isolated environment for the Enterprise Resilience Demonstration (SOW, 20 Nov 2026).
// Imported FIRST by every demo script (ES modules evaluate imports in order), so the app modules imported after it see this
// environment. It makes the demo physically unable to touch production:
//   - database: the TEST cluster (INAYA_USE_TEST_DB=1 swaps MONGODB_URI for TEST_MONGODB_URI in src/lib/mongodb.js);
//   - file storage: a local folder only -- the Filebase and Pinata credentials are blanked, and the providers report
//     themselves unconfigured on the test database anyway (src/lib/pinningProviders/testGuard.js);
//   - e-mail: the Resend keys are replaced by a placeholder, so any send fails authentication and nothing is delivered;
//   - ransomware signals: on, as in production.
// It refuses to run if the test database is not configured or is the same as the production one.
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

export const DEMO_HOME = process.env.RESILIENCE_DEMO_HOME || path.join(os.homedir(), "Downloads", "Inaya-Resilience-Demo");
export const DEMO_STORAGE_DIR = path.join(DEMO_HOME, "storage");
export const DEMO_EVIDENCE_DIR = path.join(DEMO_HOME, "evidence");
mkdirSync(DEMO_STORAGE_DIR, { recursive: true });
mkdirSync(DEMO_EVIDENCE_DIR, { recursive: true });

const prodUri = process.env.MONGODB_URI || "";
const testUri = process.env.TEST_MONGODB_URI || "";
if (!testUri) { console.error("REFUSED: TEST_MONGODB_URI is not set -- the demo only runs on the test database."); process.exit(2); }
const hostOf = (uri) => { try { return new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).hostname; } catch { return ""; } };
export const PROD_DB_HOST = hostOf(prodUri), TEST_DB_HOST = hostOf(testUri);
if (testUri === prodUri) { console.error("REFUSED: TEST_MONGODB_URI is the same as the production database."); process.exit(2); }

export const DISABLED = "disabled-for-resilience-demo";
export const DEMO_ENV = {
  INAYA_USE_TEST_DB: "1",
  // Placeholder values, never empty strings: Windows deletes an empty environment variable, and Next.js would then load the
  // real value from .env.local. A placeholder is kept, and any use of it fails authentication.
  INAYA_TESTS_USE_REAL_STORAGE: "0",
  INAYA_LOCAL_PIN_DIR: DEMO_STORAGE_DIR,
  FILEBASE_ACCESS_KEY: DISABLED, FILEBASE_SECRET_KEY: DISABLED, FILEBASE_BUCKET: DISABLED,
  PINATA_JWT: DISABLED, PINATA_API_KEY: DISABLED, PINATA_SECRET_API_KEY: DISABLED,
  RESEND_API_KEY: DISABLED, RESEND_MARKETING_API_KEY: DISABLED, RESEND_INBOUND_API_KEY: DISABLED,
  FEATURE_RANSOMWARE_SIGNALS: "on",
  LICENSE_AUTO_SUSPEND: "off",
};
Object.assign(process.env, DEMO_ENV);
