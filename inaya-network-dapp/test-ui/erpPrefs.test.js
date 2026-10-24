// test-ui/erpPrefs.test.js -- ERP mode layout/theme preferences.

import { readErpPrefs, writeErpPrefs, resolveLayout, ERP_PREFS_KEY } from "../src/lib/erpPrefs";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
}

test("defaults: ERP on in the desktop app, standard on the web", () => {
  const prefs = readErpPrefs(memoryStorage());
  expect(resolveLayout({ prefs, isDesktop: true })).toBe("erp");
  expect(resolveLayout({ prefs, isDesktop: false })).toBe("standard");
  expect(prefs.theme).toBe("classic");
});

test("a saved choice wins over the platform default, both ways", () => {
  expect(resolveLayout({ prefs: { layout: "standard" }, isDesktop: true })).toBe("standard");
  expect(resolveLayout({ prefs: { layout: "erp" }, isDesktop: false })).toBe("erp");
});

test("?layout= overrides for one visit and ignores junk", () => {
  expect(resolveLayout({ prefs: { layout: "standard" }, isDesktop: false, search: "?view=crm&layout=erp" })).toBe("erp");
  expect(resolveLayout({ prefs: { layout: null }, isDesktop: false, search: "?layout=nonsense" })).toBe("standard");
});

test("round-trips through storage and sanitizes bad values", () => {
  const s = memoryStorage();
  writeErpPrefs(s, { layout: "erp", theme: "brand", panelCollapsed: true, collapsedGroups: ["admin:it"] });
  expect(readErpPrefs(s)).toEqual({ layout: "erp", theme: "brand", panelCollapsed: true, collapsedGroups: ["admin:it"] });
  const bad = memoryStorage({ [ERP_PREFS_KEY]: JSON.stringify({ layout: "x", theme: "neon", collapsedGroups: "no" }) });
  expect(readErpPrefs(bad)).toEqual({ layout: null, theme: "classic", panelCollapsed: false, collapsedGroups: [] });
  expect(readErpPrefs(memoryStorage({ [ERP_PREFS_KEY]: "{not json" })).theme).toBe("classic");
});

test("blocked storage never throws", () => {
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(readErpPrefs(blocked).layout).toBeNull();
  expect(writeErpPrefs(blocked, { layout: "erp" })).toBe(false);
});
