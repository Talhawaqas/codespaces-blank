// test-ui/erpModules.test.js
//
// ERP mode (docs/erp-mode-plan.md). Proves ERP mode can reach everything
// the standard layout can, keeps industry OS isolation, and never decides
// visibility on its own.

import fs from "node:fs";
import path from "node:path";
import { NAV_ITEMS, isNavItemVisible } from "../src/lib/navigation/navItems";
import {
  ERP_MODULES, ERP_EXTRA_VIEWS, ERP_FOCUS_BY_INDUSTRY, erpLayout, erpModuleFor, erpPlacedViews, erpLabelFor, erpActiveItem,
  parseErpItem, erpDefaultSection, erpListsSections,
} from "../src/lib/navigation/erpModules";

const INDUSTRY_KEYS = ["health", "legal", "regulated", "financial", "government", "education"];
const VERTICALS = ["general", "healthcare", "legal", "regulated", "financial", "private_capital", "government", "education"];
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

function visibleKeys({ canManage = true, membership = { role: "owner" }, vertical = "general" } = {}) {
  return NAV_ITEMS.filter((i) => isNavItemVisible(i, { canManage, membership, vertical })).map((i) => i.key);
}
const allViews = (layout) => [...new Set(layout.flatMap((m) => m.groups.flatMap((g) => g.items.map((i) => i.view))))];
const allKeys = (layout) => layout.flatMap((m) => m.groups.flatMap((g) => g.items.map((i) => i.key)));

describe("inventory: nothing live is left out", () => {
  test("every NAV_ITEMS key and every extra view is placed, each in exactly one module", () => {
    const expected = [...NAV_ITEMS.map((i) => i.key), ...ERP_EXTRA_VIEWS];
    expect([...erpPlacedViews()].sort()).toEqual([...expected].sort());
    const owner = new Map();
    for (const m of ERP_MODULES) for (const g of m.groups) for (const i of g.items) {
      const v = parseErpItem(i).view;
      if (v === "moduleOverview") continue; // one Overview per module, by design
      if (owner.has(v)) expect(owner.get(v)).toBe(m.id);
      owner.set(v, m.id);
    }
  });

  test("no task-panel item is listed twice", () => {
    const items = ERP_MODULES.flatMap((m) => m.groups.flatMap((g) => g.items));
    expect(new Set(items).size).toBe(items.length);
  });

  test("every view the workspace renders is reachable from an ERP module", () => {
    // Reads the real render switch in business/page.js, so a new view added
    // there without an ERP home fails this test.
    const rendered = new Set([...read("src/app/business/page.js").matchAll(/activeView === "([a-zA-Z]+)"/g)].map((m) => m[1]));
    const placed = new Set(erpPlacedViews());
    expect([...rendered].filter((k) => k !== "browse" && !placed.has(k))).toEqual([]);
    expect(rendered.size).toBeGreaterThan(60);
  });

  test("ERP mode shows exactly the views the standard layout shows, for every role and industry", () => {
    const people = [
      { canManage: true, membership: { role: "owner" } },
      { canManage: false, membership: { role: "member" } },
      { canManage: false, membership: { role: "member", adminRoles: ["securityAdmin"] } },
      { canManage: false, membership: { role: "member", adminRoles: ["integrationAdmin", "helpdeskAdmin"] } },
    ];
    for (const vertical of VERTICALS) {
      for (const p of people) {
        const keys = visibleKeys({ ...p, vertical });
        const shown = allViews(erpLayout({ visibleKeys: keys })).filter((k) => !ERP_EXTRA_VIEWS.includes(k));
        expect([...shown].sort()).toEqual([...keys].sort());
      }
    }
  });
});

describe("sections and actions point at things that really exist", () => {
  // The section ids each screen really has, read from its source, so a
  // renamed tab breaks this test instead of silently breaking the panel.
  const SOURCES = {
    finance: "src/components/business/FinanceView.js",
    hr: "src/components/business/HRView.js",
    inventory: "src/components/business/InventoryView.js",
    procurement: "src/components/business/ProcurementView.js",
    crm: "src/components/business/CRMView.js",
    tasks: "src/components/business/TasksView.js",
  };
  const items = ERP_MODULES.flatMap((m) => m.groups.flatMap((g) => g.items)).map(parseErpItem);

  test("every listed section is a real tab of its screen", () => {
    for (const i of items.filter((x) => x.section && !x.action && x.view !== "moduleOverview")) {
      expect(Object.keys(SOURCES)).toContain(i.view);
      expect(read(SOURCES[i.view])).toMatch(new RegExp(`useErpSection\\([^)]*"${i.section}"`));
    }
  });

  test("every \"New ...\" item is wired to that screen's own form", () => {
    for (const i of items.filter((x) => x.action === "new")) {
      expect(read(SOURCES[i.view])).toContain(`useErpCreate("${i.section}"`);
    }
  });

  test("defaults and active item", () => {
    expect(erpDefaultSection("finance")).toBe("invoices");
    expect(erpDefaultSection("tasks")).toBeNull();
    expect(erpListsSections("hr")).toBe(true);
    expect(erpListsSections("support")).toBe(false);
    expect(erpActiveItem("finance")).toBe("finance:invoices");
    expect(erpActiveItem("finance", "documents", "ledger")).toBe("finance:ledger");
    expect(erpActiveItem("support", "documents", "tickets")).toBe("support");
    expect(erpActiveItem("browse", "projects")).toBe("projects");
  });

  test("labels: every action and section has ERP wording", () => {
    for (const i of items.filter((x) => x.section)) expect(erpLabelFor(i.key)).not.toBe(i.key);
  });
});

describe("industry OS isolation", () => {
  const expectedOs = { general: [], healthcare: ["health"], legal: ["legal"], regulated: ["regulated"], financial: ["financial"], private_capital: ["financial"], government: ["government"], education: ["education"] };

  test.each(VERTICALS)("a %s company sees only its own industry OS", (vertical) => {
    const layout = erpLayout({ visibleKeys: visibleKeys({ vertical }) });
    expect(allViews(layout).filter((k) => INDUSTRY_KEYS.includes(k))).toEqual(expectedOs[vertical]);
    const tile = layout.find((m) => m.id === "industry");
    if (expectedOs[vertical].length) {
      expect(tile.label).toBe(erpLabelFor(expectedOs[vertical][0]));
      expect(tile.home.view).toBe(expectedOs[vertical][0]);
    } else {
      expect(tile).toBeUndefined();
    }
  });

  test("the layout never adds a view the caller did not pass in", () => {
    const layout = erpLayout({ visibleKeys: ["osHome", "legal"] });
    expect(allViews(layout).sort()).toEqual(["apps", "legal", "osHome"]);
  });
});

describe("module structure", () => {
  test("module ids are unique and each module opens on something it shows", () => {
    expect(new Set(ERP_MODULES.map((m) => m.id)).size).toBe(ERP_MODULES.length);
    for (const m of erpLayout({ visibleKeys: visibleKeys() })) {
      expect(allViews([m])).toContain(m.home.view);
      expect(m.home.action).toBeNull();
    }
  });

  test("a member without admin rights still gets a usable Admin tile for their own account", () => {
    const layout = erpLayout({ visibleKeys: visibleKeys({ canManage: false, membership: { role: "member" } }) });
    const admin = layout.find((m) => m.id === "admin");
    expect(allKeys([admin])).toEqual(expect.arrayContaining(["security", "appearance"]));
    expect(allKeys([admin])).not.toContain("settings");
    expect(admin.home.view).toBe("security");
  });

  test("erpModuleFor resolves views, including the Departments/Projects/Documents browser", () => {
    expect(erpModuleFor("finance")).toBe("accounting");
    expect(erpModuleFor("legal")).toBe("industry");
    expect(erpModuleFor("browse", "documents")).toBe("documents");
    expect(erpModuleFor("browse", "projects")).toBe("workplace");
    expect(erpModuleFor("browse", "departments")).toBe("workplace");
    expect(erpModuleFor("unknownView")).toBe("home");
  });

  test("module Overviews: one per core module, and never shown on their own", () => {
    const { ERP_OVERVIEW_MODULES } = require("../src/components/business/erp/ErpModuleOverview");
    const listed = ERP_MODULES.flatMap((m) => m.groups.flatMap((g) => g.items)).map(parseErpItem).filter((i) => i.view === "moduleOverview");
    expect(listed.map((i) => i.section).sort()).toEqual([...ERP_OVERVIEW_MODULES].sort());
    for (const i of listed) expect(erpModuleFor("moduleOverview", "documents", i.section)).toBe(i.section);
    // Someone who can only see Home gets only Home: no Overview-only tiles.
    expect(erpLayout({ visibleKeys: ["osHome"] }).map((m) => m.id)).toEqual(["home"]);
  });

  test("parseErpItem", () => {
    expect(parseErpItem("finance:invoices!new")).toEqual({ key: "finance:invoices!new", view: "finance", section: "invoices", action: "new" });
    expect(parseErpItem("crm")).toEqual({ key: "crm", view: "crm", section: null, action: null });
  });
});

describe("every tabbed screen gives its tabs to the task panel", () => {
  // Every screen that switches between top-level tabs. In ERP mode its tab bar is hidden, so it
  // must hand its tabs to the task panel (useErpSection with [key, label] pairs) and mark the bar
  // (data-erp-tabs) -- or, for the core modules ERP_MODULES lists itself, hide the bar in code.
  const CORE = ["FinanceView", "HRView", "InventoryView", "ProcurementView", "CRMView"];
  const REPORTED = [
    "admin/ComplianceReadinessView", "gateway/GatewayView", "governance/GovernanceView", "AiSecurityView", "BookkeeperView",
    "DeviceProtectionView", "DocumentAutomationView", "EnterpriseHardeningView", "ExecutiveDashboardView", "FinancialView",
    "GovernmentView", "HealthView", "IdentityView", "InfrastructureView", "IntegrationsView", "LegalView", "NasManagementView",
    "RegulatedView", "SecurityResilienceView", "StorageManagerView", "SupportView", "WorkflowsView",
  ];
  const src = (f) => read(`src/components/business/${f}.js`);

  test.each(CORE)("%s: sections from the panel, tab bar hidden in ERP mode", (f) => {
    expect(src(f)).toMatch(/useErpSection\("/);
    expect(src(f)).toMatch(/\{!tabsHidden && \(/);
  });

  test.each(REPORTED)("%s: reports labelled tabs and marks its tab bar", (f) => {
    const s = src(f);
    expect(s).toMatch(/useErpSection\(/);
    expect(s).toContain("data-erp-tabs");
    // Top-level tab state only; nested panels (a Legal matter's own sections) keep theirs.
    expect(s).not.toMatch(/const \[tab, setTab\] = useState\("/);
  });

  test("no other screen still keeps top-level tab state of its own", () => {
    // A new tabbed screen added later must join one of the lists above.
    const dir = path.join(__dirname, "../src/components/business");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith("View.js"));
    const known = new Set([...CORE, ...REPORTED].map((f) => f.split("/").pop()));
    const offenders = files.filter((f) => !known.has(f.replace(/\.js$/, "")) && /const \[tab, setTab\] = useState\("/.test(fs.readFileSync(path.join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("industry tile order", () => {
  test("a general company keeps the usual module order", () => {
    const ids = erpLayout({ visibleKeys: visibleKeys() }).map((m) => m.id);
    expect(ids).toEqual(ERP_MODULES.map((m) => m.id).filter((id) => ids.includes(id)));
  });

  test.each(["healthcare", "legal", "regulated", "financial", "private_capital", "government", "education"])("a %s company sees Home, its industry tile, then its focus modules", (vertical) => {
    const keys = visibleKeys({ vertical });
    const ids = erpLayout({ visibleKeys: keys }).map((m) => m.id);
    const industryKey = keys.find((k) => ERP_FOCUS_BY_INDUSTRY[k]);
    const focus = ERP_FOCUS_BY_INDUSTRY[industryKey];
    expect(ids.slice(0, focus.length + 1)).toEqual(["home", ...focus]);
    // Order only: the same tiles as before, nothing removed.
    expect([...ids].sort()).toEqual(erpLayout({ visibleKeys: keys.filter((k) => k !== industryKey) }).map((m) => m.id).concat("industry").sort());
  });
});
