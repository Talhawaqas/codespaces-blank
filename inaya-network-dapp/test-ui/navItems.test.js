// test-ui/navItems.test.js
//
// Command Palette + Virtual Guide SOW -- isNavItemVisible is the exact
// predicate the sidebar always used (now lifted out of page.js so the
// command palette's server-side search can share it). This pins its
// behavior for all four gating shapes NAV_ITEMS actually uses.

import { isNavItemVisible, NAV_ITEMS, searchWordsFor } from "../src/lib/navigation/navItems";

test("an unrestricted item is always visible", () => {
  const item = { key: "osHome", label: "OS Home" };
  expect(isNavItemVisible(item, { canManage: false, membership: {}, vertical: "general" })).toBe(true);
});

test("manageOnly with no adminRole: visible only to owner/admin (canManage)", () => {
  // Note: with no adminRole, the (!manageOnly || canManage || (adminRole && ...)) expression's
  // third term short-circuits to `undefined` (not `false`) when adminRole itself is undefined --
  // byte-identical to the original inline predicate this was lifted from (page.js:958), which
  // relied on Array.filter() treating any falsy value, undefined included, as "exclude." Asserting
  // falsy/truthy here, not strict boolean equality, so this test doesn't force a behavior change.
  const item = { key: "billing", label: "Billing", manageOnly: true };
  expect(isNavItemVisible(item, { canManage: false, membership: {}, vertical: "general" })).toBeFalsy();
  expect(isNavItemVisible(item, { canManage: true, membership: {}, vertical: "general" })).toBe(true);
});

test("manageOnly with adminRole: a matching admin role grants access even without canManage", () => {
  const item = { key: "webhooks", label: "Webhooks", manageOnly: true, adminRole: "integrationAdmin" };
  const membership = { adminRoles: ["integrationAdmin"] };
  expect(isNavItemVisible(item, { canManage: false, membership, vertical: "general" })).toBe(true);
  expect(isNavItemVisible(item, { canManage: false, membership: { adminRoles: [] }, vertical: "general" })).toBe(false);
});

test("verticalOnly as a string only matches that exact vertical", () => {
  const item = { key: "health", label: "Health OS", verticalOnly: "healthcare" };
  expect(isNavItemVisible(item, { canManage: true, membership: {}, vertical: "healthcare" })).toBe(true);
  expect(isNavItemVisible(item, { canManage: true, membership: {}, vertical: "general" })).toBe(false);
});

test("verticalOnly as an array matches any listed vertical", () => {
  const item = { key: "financial", label: "Financial OS", verticalOnly: ["financial", "private_capital"] };
  expect(isNavItemVisible(item, { canManage: true, membership: {}, vertical: "private_capital" })).toBe(true);
  expect(isNavItemVisible(item, { canManage: true, membership: {}, vertical: "healthcare" })).toBe(false);
});

test("NAV_ITEMS has no duplicate keys", () => {
  const keys = NAV_ITEMS.map((i) => i.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("searchWordsFor falls back to label+group when no synonym override exists", () => {
  const item = { key: "osHome", label: "OS Home", group: "core" };
  expect(searchWordsFor(item)).toBe("os home core");
});

test("searchWordsFor uses the synonym override when one exists", () => {
  const item = NAV_ITEMS.find((i) => i.key === "procurement");
  expect(searchWordsFor(item)).toContain("purchase orders");
});
