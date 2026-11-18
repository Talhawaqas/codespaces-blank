// scripts/sqa/start-testdb-walkthrough.mjs -- the production build on the TEST database for a License Manager browser
// walkthrough (SOW 21.6): a throwaway admin passphrase (never the real one), automatic suspension on so it can be
// demonstrated, and export ZIPs written to the storage bucket (removed again afterwards).
//   ADMIN_PASS_FILE=<file with a throwaway passphrase> node scripts/sqa/start-testdb-walkthrough.mjs
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const pass = readFileSync(process.env.ADMIN_PASS_FILE || ".next-prod/walk-admin-pass.txt", "utf8").trim(); // build folder: never committed
if (pass.length < 16) throw new Error("ADMIN_PASS_FILE must hold a throwaway passphrase of 16+ characters");
const env = { ...process.env, INAYA_USE_TEST_DB: "1", NEXT_DIST_DIR: ".next-prod", ADMIN_DASHBOARD_PASSPHRASE: pass, LICENSE_AUTO_SUSPEND: "on", INAYA_TESTS_USE_REAL_STORAGE: "1", RESEND_API_KEY: "", LICENSE_ADMIN_NAME: "Walkthrough admin" };
const child = spawn("npx", ["next", "start", "-p", "3002"], { stdio: "inherit", shell: true, env });
child.on("exit", (code) => process.exit(code ?? 0));
