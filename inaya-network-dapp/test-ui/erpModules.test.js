// test-ui/erpModules.test.js
//
// ERP mode (docs/erp-mode-plan.md). Proves ERP mode can reach everything
// the standard layout can, keeps industry OS isolation, and never decides
// visibility on its own.

import fs from "node:fs";
import path from "node:path";
import { NAV_ITEMS, isNavItemVisible } from "../src/lib/navigation/navItems";
import { ERP_MODULES, ERP_EXTRA_VIEWS, erpLayout, erpModuleFor, erpPlacedKeys, erpLabelFor, erpActiveItem } from "../src/lib/navigation/erpModules";

const INDUSTRY_KEYS = ["health", "legal", "regulated", "financial", "government"];
const VERTICALS = ["general", "healthcare", "legal", "regulated", "financial", "private_capital", "government"];

function visibleKeys({ canManage = true, membership = { role: "owner" }, vertical = "general" } = {}) {
  return NAV_ITEMS.filter((i) => isNavItemVisible(i, { canManage, membership, vertical })).map((i) => i.key);
}

function allItemKeys(layout) {
  return layout.flatMap((m) => m.groups.flatMap((g) => g.items.map((i) => i.key)));
}

describe("inventory: nothing live is left out", () => {
  test("every NAV_ITEMS key and every extra view is placed exactly once", () => {
    const placed = erpPlacedKeys();
    const expected = [...NAV_ITEMS.map((i) => i.key), ...ERP_EXTRA_VIEWS];
    expect([...placed].sort()).toEqual([...expected].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  test("every view the workspace renders is reachable from an ERP module", () => {
    // Reads the real render switch in business/page.js, so a new view added
    // there without an ERP home fails this test.
    const src = fs.readFileSync(path.join(__dirname, "../src/app/business/page.js"), "utf8");
    const rendered = new Set([...src.matchAll(/activeView === "([a-zA-Z]+)"/g)].map((m) => m[1]));
    const placed = new Set(erpPlacedKeys());
    const missing = [...rendered].filter((k) => k !== "browse" && !placed.has(k));
    expect(missing).toEqual([]);
    expect(rendered.size).toBeGreaterThan(60);
  });

  test("an owner of a general company sees every non-industry view in ERP mode", () => {
    const keys = visibleKeys();
    const layoutKeys = new Set(allItemKeys(erpLayout({ visibleKeys: keys })));
    for (const k of keys) expect(layoutKeys.has(k)).toBe(true);
    expect(layoutKeys.has("apps")).toBe(true);
  });

  test("ERP mode shows exactly what the standard layout shows, for every role and industry", () => {
    const people = [
      { canManage: true, membership: { role: "owner" } },
      { canManage: false, membership: { role: "member" } },
      { canManage: false, membership: { role: "member", adminRoles: ["securityAdmin"] } },
      { canManage: false, membership: { role: "member", adminRoles: ["integrationAdmin", "helpdeskAdmin"] } },
    ];
    for (const vertical of VERTICALS) {
      for (const p of people) {
        const keys = visibleKeys({ ...p, vertical });
        const shown = allItemKeys(erpLayout({ visibleKeys: keys })).filter((k) => !ERP_EXTRA_VIEWS.includes(k));
        expect([...shown].sort()).toEqual([...keys].sort());
      }
    }
  });
});

describe("industry OS isolation", () => {
  const expectedOs = { general: [], healthcare: ["health"], legal: ["legal"], regulated: ["regulated"], financial: ["financial"], private_capital: ["financial"], government: ["government"] };

  test.each(VERTICALS)("a %s company sees only its own industry OS", (vertical) => {
    const layout = erpLayout({ visibleKeys: visibleKeys({ vertical }) });
    const industryShown = allItemKeys(layout).filter((k) => INDUSTRY_KEYS.includes(k));
    expect(industryShown).toEqual(expectedOs[vertical]);
    const tile = layout.find((m) => m.id === "industry");
    if (expectedOs[vertical].length) {
      expect(tile.label).toBe(erpLabelFor(expectedOs[vertical][0]));
      expect(tile.home).toBe(expectedOs[vertical][0]);
    } else {
      expect(tile).toBeUndefined();
    }
  });

  test("the layout never adds a view the caller did not pass in", () => {
    const layout = erpLayout({ visibleKeys: ["osHome", "legal"] });
    expect(allItemKeys(layout).sort()).toEqual(["apps", "legal", "osHome"]);
  });
});

describe("module structure", () => {
  test("module ids are unique and each module has a home view it can show", () => {
    expect(new Set(ERP_MODULES.map((m) => m.id)).size).toBe(ERP_MODULES.length);
    for (const m of erpLayout({ visibleKeys: visibleKeys() })) {
      expect(allItemKeys([m])).toContain(m.home);
    }
  });

  test("a member without admin rights still gets a usable Admin tile for their own account security", () => {
    const layout = erpLayout({ visibleKeys: visibleKeys({ canManage: false, membership: { role: "member" } }) });
    const admin = layout.find((m) => m.id === "admin");
    expect(allItemKeys([admin])).toContain("security");
    expect(allItemKeys([admin])).not.toContain("settings");
  });

  test("erpModuleFor resolves views, including the Departments/Projects/Documents browser", () => {
    expect(erpModuleFor("finance")).toBe("accounting");
    expect(erpModuleFor("legal")).toBe("industry");
    expect(erpModuleFor("browse", "documents")).toBe("documents");
    expect(erpModuleFor("browse", "projects")).toBe("workplace");
    expect(erpModuleFor("browse", "departments")).toBe("workplace");
    expect(erpModuleFor("unknownView")).toBe("home");
    expect(erpActiveItem("browse", "projects")).toBe("projects");
    expect(erpActiveItem("crm")).toBe("crm");
  });
});
