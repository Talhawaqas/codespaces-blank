// src/lib/pinningProviders/testGuard.js
//
// Keeps test runs away from the real storage accounts (SQA 17 Nov 2026). Test runs used the same Pinata and
// Filebase accounts as production: every run left pins behind, Pinata's plan filled up (504 of 500 files) and
// refused all uploads, including customers'. Under the test runner, or a dev server started on the test database
// (npm run dev:testdb), the real providers now report themselves unconfigured and shards go to the local provider
// in a temp directory. A test that deliberately exercises a real provider sets INAYA_TESTS_USE_REAL_STORAGE=1
// and must clean up after itself.

import os from "node:os";
import path from "node:path";

export const inTestRun = () => Boolean(process.env.NODE_TEST_CONTEXT || process.env.INAYA_USE_TEST_DB === "1");

export const realStorageAllowed = () => !inTestRun() || process.env.INAYA_TESTS_USE_REAL_STORAGE === "1";

/** Where the local provider keeps shards: INAYA_LOCAL_PIN_DIR, or a temp directory during test runs. */
export const localPinDir = () => process.env.INAYA_LOCAL_PIN_DIR || (inTestRun() ? path.join(os.tmpdir(), "inaya-test-pins") : "");
