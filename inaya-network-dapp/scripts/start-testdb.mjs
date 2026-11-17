// scripts/start-testdb.mjs  ->  npm run start:testdb
// Serves the PRODUCTION build (`next build` first) on the TEST database (TEST_MONGODB_URI), on port 3001, so quality
// checks see what customers get (pre-built pages, no dev compilation) without touching live data.
// src/lib/mongodb.js switches when INAYA_USE_TEST_DB=1 and refuses if the test URI is missing or names the live cluster.
import { spawn } from "node:child_process";
const child = spawn("npx", ["next", "start", "-p", "3001", ...process.argv.slice(2)], { stdio: "inherit", shell: true, env: { ...process.env, INAYA_USE_TEST_DB: "1", NEXT_DIST_DIR: process.env.NEXT_DIST_DIR || ".next-prod" } }); // built with NEXT_DIST_DIR=.next-prod next build
child.on("exit", (code) => process.exit(code ?? 0));
