// test/docs-openapi.test.mjs
// Official Documentation Platform SOW.
// Run with: node --test test/docs-openapi.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { API_ENDPOINTS } from "../src/lib/docsApiReference.js";

const OPENAPI_PATH = path.join(process.cwd(), "public", "openapi.json");

test("generate-openapi.mjs produces a spec covering every API_ENDPOINTS path, with every path parameter declared", () => {
  execSync("node scripts/docs/generate-openapi.mjs", { cwd: process.cwd(), stdio: "pipe" });
  assert.ok(fs.existsSync(OPENAPI_PATH), "public/openapi.json was not written");

  const spec = JSON.parse(fs.readFileSync(OPENAPI_PATH, "utf8"));
  assert.equal(spec.openapi, "3.0.3");
  assert.ok(spec.info?.title);
  assert.ok(spec.components?.securitySchemes?.bearerAuth, "must declare the real bearer-key auth scheme, not leave auth undocumented");

  const specPaths = Object.keys(spec.paths);
  const endpointPaths = [...new Set(API_ENDPOINTS.map((ep) => ep.path))];
  assert.deepEqual(specPaths.sort(), endpointPaths.sort(), "the generated spec's paths must exactly match docsApiReference.js -- no drift between the rendered API reference and the downloadable spec");

  for (const ep of API_ENDPOINTS) {
    const pathItem = spec.paths[ep.path];
    const methods = ep.method.split(",").map((m) => m.trim().toLowerCase());
    for (const method of methods) {
      assert.ok(pathItem[method], `${ep.path} is missing its ${method.toUpperCase()} operation`);
      assert.ok(pathItem[method].security?.length > 0, `${ep.path} ${method} must declare security -- every real route requires an API key`);
    }
    const placeholders = [...ep.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const name of placeholders) {
      const anyMethod = Object.values(pathItem)[0];
      assert.ok(anyMethod.parameters?.some((p) => p.name === name && p.in === "path"), `${ep.path} must declare the path parameter "${name}"`);
    }
  }
});
