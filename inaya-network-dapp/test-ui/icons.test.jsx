// test-ui/icons.test.jsx
//
// Business Workspace UX/UI Makeover SOW -- Icon/ICONS was reinvented 3
// times (page.js, OperatorSidebar.js, tileIcons.js -- see
// BUSINESS_WORKSPACE_UX_AUDIT.md #3.1) before being centralized here.

import { render } from "@testing-library/react";
import { Icon, ICONS } from "../src/components/business/ui/icons";

test("every nav icon key used by NAV_ITEMS in business/page.js has a real path defined", () => {
  const navIconKeys = [
    "dashboard", "insights", "departments", "projects", "documents", "tasks", "crm", "procurement",
    "inventory", "finance", "hr", "health", "legal", "regulated", "financial", "government", "resilience",
    "integrations", "executive", "dataRooms", "enterpriseHardening", "approvals", "aiAssistant",
    "activity", "billing", "settings",
  ];
  for (const key of navIconKeys) {
    expect(ICONS[key]).toBeTruthy();
  }
});

test("Icon renders an svg with the given path content", () => {
  const { container } = render(<Icon path={ICONS.documents} />);
  const svg = container.querySelector("svg");
  expect(svg).toBeInTheDocument();
  expect(svg.querySelector("path")).toBeInTheDocument();
});

test("Icon accepts a custom className, replacing the default size", () => {
  const { container } = render(<Icon path={ICONS.tasks} className="w-5 h-5" />);
  const svg = container.querySelector("svg");
  expect(svg).toHaveClass("w-5", "h-5");
  expect(svg).not.toHaveClass("w-[18px]");
});
