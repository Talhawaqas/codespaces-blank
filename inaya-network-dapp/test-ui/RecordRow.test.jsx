// test-ui/RecordRow.test.jsx
//
// Business Workspace UX/UI Makeover SOW -- codifies the clickable
// row-card pattern hand-copied identically across CRMView.js/FinanceView.js
// etc. (see BUSINESS_WORKSPACE_UX_AUDIT.md #3.1).

import { render, screen, fireEvent } from "@testing-library/react";
import RecordRow, { RecordList, RecordRows } from "../src/components/business/ui/RecordRow";

test("renders left and right content and responds to click", () => {
  const onClick = jest.fn();
  render(<RecordRow onClick={onClick} left={<span>Acme Corp</span>} right={<span>CUSTOMER</span>} />);
  expect(screen.getByText("Acme Corp")).toBeInTheDocument();
  expect(screen.getByText("CUSTOMER")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button"));
  expect(onClick).toHaveBeenCalledTimes(1);
});

test("right content is optional", () => {
  render(<RecordRow onClick={() => {}} left={<span>Just a name</span>} />);
  expect(screen.getByText("Just a name")).toBeInTheDocument();
});

test("RecordList and RecordRows wrap children in the expected containers", () => {
  const { container } = render(
    <RecordList>
      <RecordRows>
        <RecordRow onClick={() => {}} left={<span>Row 1</span>} />
      </RecordRows>
    </RecordList>
  );
  expect(screen.getByText("Row 1")).toBeInTheDocument();
  expect(container.querySelector(".rounded-2xl")).toBeTruthy();
  expect(container.querySelector(".space-y-2")).toBeTruthy();
});
