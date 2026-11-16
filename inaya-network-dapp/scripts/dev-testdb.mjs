// scripts/dev-testdb.mjs  ->  npm run dev:testdb
// Runs the local dev server on the TEST database (TEST_MONGODB_URI) instead of the live one, for the
// end-to-end tests that call http://localhost:3000 (S3 clients, rclone, AzCopy, Terraform, DirectSync,
// external tools). src/lib/mongodb.js switches when INAYA_USE_TEST_DB=1 and refuses if the test URI is
// missing or names the live cluster.
import { spawn } from "node:child_process";
const child = spawn("npx", ["next", "dev", ...process.argv.slice(2)], { stdio: "inherit", shell: true, env: { ...process.env, INAYA_USE_TEST_DB: "1" } });
child.on("exit", (code) => process.exit(code ?? 0));
