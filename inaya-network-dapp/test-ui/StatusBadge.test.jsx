// test-ui/StatusBadge.test.jsx
//
// Business Workspace UX/UI Makeover SOW -- StatusBadge merges 6+
// independently duplicated status-color maps (see
// BUSINESS_WORKSPACE_UX_AUDIT.md #3.1). These tests pin the exact tone
// classes each migrated file's status vocabulary must keep resolving to,
// so a future edit here can't silently break a specific module's colors.

import { render, screen } from "@testing-library/react";
import StatusBadge, { STATUS_TONE, TONE_CLASSES } from "../src/components/business/ui/StatusBadge";

test("renders the status text with underscores replaced by spaces", () => {
  render(<StatusBadge status="PENDING_APPROVAL" />);
  expect(screen.getByText("PENDING APPROVAL")).toBeInTheDocument();
});

test("known statuses resolve to their real, pinned tone", () => {
  const cases = [
    ["DRAFT", "neutral"], ["PENDING", "warning"], ["APPROVED", "success"], ["REJECTED", "danger"],
    ["PAID", "success"], ["OVERDUE", "danger"], ["DONE", "success"], ["BLOCKED", "warning"],
    ["WON", "success"], ["LOST", "danger"], ["PROPOSAL", "special"],
  ];
  for (const [status, tone] of cases) {
    const { container, unmount } = render(<StatusBadge status={status} />);
    for (const cls of TONE_CLASSES[tone].split(" ")) {
      expect(container.querySelector("span")).toHaveClass(cls);
    }
    unmount();
  }
});

test("an unknown status falls back to the neutral tone, not a crash", () => {
  const { container } = render(<StatusBadge status="SOME_MADE_UP_STATUS" />);
  for (const cls of TONE_CLASSES.neutral.split(" ")) {
    expect(container.querySelector("span")).toHaveClass(cls);
  }
});

test("an explicit tone prop overrides the automatic status lookup", () => {
  // e.g. TasksView/ProcurementView's CANCELLED, which was violet ("special")
  // in the original files, not the shared default's neutral.
  const { container } = render(<StatusBadge status="CANCELLED" tone="special" />);
  for (const cls of TONE_CLASSES.special.split(" ")) {
    expect(container.querySelector("span")).toHaveClass(cls);
  }
});

test("STATUS_TONE export covers every status this SOW's audit found across the 6 duplicated maps", () => {
  const expected = [
    "TODO", "IN_PROGRESS", "BLOCKED", "DONE", "NEW", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST",
    "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "SENT", "RECORDED", "ONBOARDING", "ON_LEAVE", "TERMINATED",
    "QUEUED", "EXECUTED", "EXPIRED", "DRAFT", "PENDING", "PENDING_APPROVAL", "APPROVED", "REJECTED", "PAID", "OVERDUE",
  ];
  for (const status of expected) {
    expect(STATUS_TONE[status]).toBeDefined();
  }
});

test("renders a leading dot indicator so color is never the only signal (SOW §13)", () => {
  const { container } = render(<StatusBadge status="APPROVED" />);
  expect(container.querySelector("span > span[aria-hidden='true']")).toBeInTheDocument();
});
