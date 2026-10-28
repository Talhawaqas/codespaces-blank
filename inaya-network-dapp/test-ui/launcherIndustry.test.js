// test-ui/launcherIndustry.test.js
//
// The short sidebar for industry OS companies (launcher.js
// PRIMARY_NAV_KEYS_BY_INDUSTRY): the industry module is always there, the
// general set is unchanged for general companies, and nothing becomes
// unreachable (every visible module is still in All apps).

import { NAV_ITEMS, isNavItemVisible } from "../src/lib/navigation/navItems";
import { sidebarSections, launcherGroups, PRIMARY_NAV_KEYS, PRIMARY_NAV_KEYS_BY_INDUSTRY } from "../src/lib/navigation/launcher";

const visibleFor = (vertical) => NAV_ITEMS.filter((i) => isNavItemVisible(i, { canManage: true, membership: { role: "owner" }, vertical }));
const INDUSTRY = { healthcare: "health", legal: "legal", regulated: "regulated", financial: "financial", private_capital: "financial", government: "government", education: "education" };

test("a general company keeps the usual everyday set", () => {
  expect(sidebarSections({ visible: visibleFor("general") }).primary.map((i) => i.key)).toEqual(PRIMARY_NAV_KEYS);
});

test.each(Object.entries(INDUSTRY))("a %s company gets its industry module second in the sidebar", (vertical, key) => {
  const visible = visibleFor(vertical);
  const { primary, moreCount } = sidebarSections({ visible });
  const keys = primary.map((i) => i.key);
  expect(keys[0]).toBe("osHome");
  expect(keys[1]).toBe(key);
  expect(keys).toEqual(PRIMARY_NAV_KEYS_BY_INDUSTRY[key].filter((k) => visible.some((i) => i.key === k)));
  expect(moreCount).toBe(visible.length - primary.length);
  const inLauncher = launcherGroups({ visible }).flatMap((g) => g.items.map((i) => i.key));
  expect([...inLauncher].sort()).toEqual(visible.map((i) => i.key).sort());
});

test("a school's sidebar leaves out Purchasing, Inventory and Customers, but All apps still has them", () => {
  const visible = visibleFor("education");
  const keys = sidebarSections({ visible }).primary.map((i) => i.key);
  for (const k of ["procurement", "inventory", "crm"]) expect(keys).not.toContain(k);
  const inLauncher = launcherGroups({ visible }).flatMap((g) => g.items.map((i) => i.key));
  expect(inLauncher).toEqual(expect.arrayContaining(["procurement", "inventory", "crm"]));
});

test("a pinned module still shows for an industry company", () => {
  const { pinned } = sidebarSections({ visible: visibleFor("education"), pins: ["inventory"] });
  expect(pinned.map((i) => i.key)).toEqual(["inventory"]);
});

test("a member who cannot see an industry primary item just doesn't get it", () => {
  const visible = NAV_ITEMS.filter((i) => isNavItemVisible(i, { canManage: false, membership: { role: "member" }, vertical: "financial" }));
  const keys = sidebarSections({ visible }).primary.map((i) => i.key);
  expect(keys).not.toContain("dataRooms");
  expect(keys[1]).toBe("financial");
});
