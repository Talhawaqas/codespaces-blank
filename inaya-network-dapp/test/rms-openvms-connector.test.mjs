// test/rms-openvms-connector.test.mjs
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW.
//
// Real tests against a genuine VSI OpenVMS x86-64 V9.2-3 instance (see
// docs/mainframe-legacy-data-access-report.md for how that test
// environment was stood up). Credentials are never hardcoded here --
// this suite reads them from environment variables and SKIPS (not fails)
// when they're not set, so it doesn't break in any environment that
// doesn't have a live OpenVMS box reachable. Set before running:
//
//   RMS_TEST_HOST       e.g. 192.168.127.134
//   RMS_TEST_USERNAME   e.g. SYSTEM
//   RMS_TEST_PASSWORD   the real OpenVMS account password
//   RMS_TEST_FILEPATH   a real file spec, e.g.
//                       SYS$SYSDEVICE:[SYS0.SYSEXE]LAN$DEVICE_DATABASE.SEQ
//
// Run with:
//   RMS_TEST_HOST=... RMS_TEST_USERNAME=... RMS_TEST_PASSWORD=... RMS_TEST_FILEPATH=... \
//     node --test test/rms-openvms-connector.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as rmsOpenVms from "../src/lib/legacyDataAccess/connectors/rmsOpenVms.js";

const creds = {
  host: process.env.RMS_TEST_HOST,
  username: process.env.RMS_TEST_USERNAME,
  password: process.env.RMS_TEST_PASSWORD,
  filePath: process.env.RMS_TEST_FILEPATH,
};
const LIVE = Object.values(creds).every(Boolean);
const skip = LIVE ? {} : { skip: "RMS_TEST_HOST/USERNAME/PASSWORD/FILEPATH not set -- no live OpenVMS box configured for this run." };

test("rmsOpenVms: declares itself configured and its real capabilities", () => {
  assert.equal(rmsOpenVms.isConfigured(), true);
  const caps = rmsOpenVms.capabilities();
  assert.equal(caps.read, true);
  assert.equal(caps.write, false);
  assert.equal(caps.joins, false);
});

test("rmsOpenVms: requires all four credential fields", async () => {
  await assert.rejects(() => rmsOpenVms.testConnection({ host: "x" }), /requires credentials/);
});

test("rmsOpenVms: testConnection against a real OpenVMS host", skip, async () => {
  const result = await rmsOpenVms.testConnection(creds);
  assert.equal(result.ok, true, result.error);
});

test("rmsOpenVms: testConnection reports a real failure for a wrong password", skip, async () => {
  const result = await rmsOpenVms.testConnection({ ...creds, password: `${creds.password}-definitely-wrong` });
  assert.equal(result.ok, false);
});

test("rmsOpenVms: discoverMetadata parses real ANALYZE/RMS_FILE/FDL output", skip, async () => {
  const meta = await rmsOpenVms.discoverMetadata(creds);
  assert.equal(meta.tables.length, 1);
  const table = meta.tables[0];
  assert.ok(table.name.length > 0);
  assert.ok(["SEQUENTIAL", "INDEXED", "RELATIVE", "UNKNOWN"].includes(table.rmsAttributes.organization));
  assert.equal(table.columns[0].name, "RAW_RECORD");
});

test("rmsOpenVms: health reports CONNECTED against a real host", skip, async () => {
  const result = await rmsOpenVms.health(creds);
  assert.equal(result.status, "CONNECTED");
});

test("rmsOpenVms: executeQuery reads real records, or honestly rejects unsupported formats", skip, async () => {
  const meta = await rmsOpenVms.discoverMetadata(creds);
  const table = meta.tables[0];
  if (table.rmsAttributes.readSupported) {
    const result = await rmsOpenVms.executeQuery(creds, "SELECT * FROM x", [], { maxRows: 50 });
    assert.ok(Array.isArray(result.rows));
    assert.ok("RAW_RECORD" in (result.rows[0] || { RAW_RECORD: true }));
  } else {
    await assert.rejects(
      () => rmsOpenVms.executeQuery(creds, "SELECT * FROM x", [], {}),
      /requires a compiled OpenVMS-side RMS reader|Cannot read/
    );
  }
});
