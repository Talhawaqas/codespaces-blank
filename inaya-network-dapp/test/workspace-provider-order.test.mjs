// test/workspace-provider-order.test.mjs
//
// Business Workspace storage order (owner decision, 17 Nov 2026): Filebase is the main upload store and Pinata is
// the fallback. Pure ordering check with stubbed providers, so it runs without credentials or a database.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, workspaceProviderOrder, WORKSPACE_PRIMARY_PROVIDER } from "../src/lib/pinningProviders/index.js";

const original = { ...PROVIDERS };
after(() => { for (const k of Object.keys(PROVIDERS)) delete PROVIDERS[k]; Object.assign(PROVIDERS, original); });
function only(configured) {
  for (const name of Object.keys(original)) PROVIDERS[name] = { ...original[name], isConfigured: () => configured.includes(name) };
}

test("Filebase is first and Pinata is last when both are configured", () => {
  only(["pinata", "filebase"]);
  assert.equal(WORKSPACE_PRIMARY_PROVIDER, "filebase");
  assert.deepEqual(workspaceProviderOrder(), ["filebase", "pinata"]);
});

test("Pinata stays last behind any other configured provider", () => {
  only(["pinata", "filebase", "local"]);
  assert.deepEqual(workspaceProviderOrder(), ["filebase", "local", "pinata"]);
});

test("Pinata is used when it is the only store configured", () => {
  only(["pinata"]);
  assert.deepEqual(workspaceProviderOrder(), ["pinata"]);
});

test("no configured store gives an empty order", () => {
  only([]);
  assert.deepEqual(workspaceProviderOrder(), []);
});
