// jest.config.js
//
// Business Workspace UX/UI Makeover SOW -- this repo had zero frontend
// test tooling before this (confirmed: no Jest/Vitest/Testing Library/
// Playwright anywhere; the existing `npm test` runs 108 backend-only
// node:test files against src/lib and src/app/api). next/jest is Next.js's
// own official helper -- it auto-configures the SWC transform plus CSS/
// image/font mocking for the App Router, the lowest-friction path for
// this exact stack. Deliberately a SEPARATE config/script from the
// existing `test` (different runner, different purpose) rather than
// merged into it.

const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "jest-environment-jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testMatch: ["<rootDir>/test-ui/**/*.test.{js,jsx}"],
  // custody-sdk is a separate nested git repo (with its own worktrees) --
  // excluded so Jest's haste map doesn't scan it and warn about duplicate
  // package names between the repo and its own worktree copies.
  modulePathIgnorePatterns: ["<rootDir>/custody-sdk"],
};

module.exports = createJestConfig(customJestConfig);
