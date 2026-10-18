// test/navigation-launcher.test.mjs
//
// Business Workspace redesign (2026-10-18) — the short sidebar, the All apps
// launcher and per-person pins (src/lib/navigation/launcher.js). Pure: no
// database. Visibility always comes from isNavItemVisible, so these tests
// also check that the new navigation never shows anything a role couldn't
// see before.
//
// Run with: node --test test/navigation-launcher.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { NAV_ITEMS, isNavItemVisible } from "../src/lib/navigation/navItems.js";
import { sidebarSections, launcherGroups, defaultPins, readNavPrefs, writeNavPrefs, PRIMARY_NAV_KEYS, LAUNCHER_GROUPS, USE_CASES, labelFor } from "../src/lib/navigation/launcher.js";

const owner = NAV_ITEMS.filter((i) => isNavItemVisible(i, { canManage: true, membership: { role: "owner" }, vertical: "general" }));
const member = NAV_ITEMS.filter((i) => isNavItemVisible(i, { canManage: false, membership: { role: "member" }, vertical: "general" }));

test("every module key exists and is placed in exactly one launcher group", () => {
  const keys = new Set(NAV_ITEMS.map((i) => i.key));
  const placed = LAUNCHER_GROUPS.flatMap((g) => g.keys);
  for (const k of [...placed, ...PRIMARY_NAV_KEYS, ...USE_CASES.flatMap((u) => u.pins)]) assert.ok(keys.has(k), `unknown nav key ${k}`);
  assert.equal(new Set(placed).size, placed.length, "no module appears in two groups");
  const unplaced = NAV_ITEMS.filter((i) => !placed.includes(i.key)).map((i) => i.key);
  assert.deepEqual(unplaced, ["osHome"], "only Home lives outside the launcher groups");
});

test("the sidebar is short: everyday areas + pins, everything else counted under All apps", () => {
  const s = sidebarSections({ visible: owner, pins: defaultPins("run"), activeKey: "osHome" });
  assert.equal(s.primary.length, PRIMARY_NAV_KEYS.length);
  assert.deepEqual(s.pinned.map((i) => i.key), ["approvals", "documentAutomation"]);
  assert.equal(s.current, null);
  assert.equal(s.primary.length + s.pinned.length + s.moreCount, owner.length);
  assert.ok(s.primary.length + s.pinned.length <= 12, "an owner no longer sees ~67 items");
  assert.equal(labelFor(s.primary[0]), "Home");
});

test("the page you're on always appears, and pins you can't see are dropped", () => {
  const s = sidebarSections({ visible: member, pins: ["approvals", "auditTrail", "shares"], activeKey: "evidence" });
  assert.deepEqual(s.pinned.map((i) => i.key), ["shares"], "manager-only pins are not shown to a member");
  assert.equal(s.current?.key, "evidence");
  assert.equal(sidebarSections({ visible: member, pins: [], activeKey: "browse" }).current, null, "browse is reached through Documents");
});

test("launcher: search and group filter, only over visible modules", () => {
  const all = launcherGroups({ visible: member });
  const shown = all.flatMap((g) => g.items.map((i) => i.key));
  assert.ok(!shown.includes("auditTrail"), "a member never sees manager-only modules in All apps");
  assert.equal(new Set(shown).size, shown.length);
  const inv = launcherGroups({ visible: owner, query: "backup", describe: (k) => (k === "deviceProtection" ? "Backup and sync for computers" : "") });
  assert.ok(inv.flatMap((g) => g.items).some((i) => i.key === "deviceProtection" || i.key === "cloudBackup"));
  assert.deepEqual(launcherGroups({ visible: owner, groupId: "money" }).map((g) => g.id), ["money"]);
  assert.deepEqual(launcherGroups({ visible: owner, query: "zzzz-no-match" }), []);
});

test("prefs round-trip and tolerate blocked or corrupt storage", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(readNavPrefs(storage, "org1"), null);
  assert.equal(writeNavPrefs(storage, "org1", { pins: ["shares"], useCase: "files", welcomed: true }), true);
  assert.deepEqual(readNavPrefs(storage, "org1"), { pins: ["shares"], useCase: "files", welcomed: true });
  assert.equal(readNavPrefs(storage, "org2"), null, "per company");
  mem.set("inaya_bw_nav:org3", "{not json");
  assert.equal(readNavPrefs(storage, "org3"), null);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readNavPrefs(blocked, "org1"), null);
  assert.equal(writeNavPrefs(blocked, "org1", { pins: [] }), false);
  assert.deepEqual(defaultPins("nope"), defaultPins("run"));
});
