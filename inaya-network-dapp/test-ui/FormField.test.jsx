// test-ui/FormField.test.jsx
//
// Business Workspace UX/UI Makeover SOW -- fixes a real accessibility gap
// the audit found: no form anywhere in the Workspace had a real <label>
// (see BUSINESS_WORKSPACE_UX_AUDIT.md #3.4). This is the test that proves
// the fix actually works -- a real, programmatically-associated label a
// screen reader (or Testing Library's getByLabelText) can find.

import { render, screen } from "@testing-library/react";
import FormField from "../src/components/business/ui/FormField";

test("the input is findable by its label text (real label association)", () => {
  render(
    <FormField label="Full name" htmlFor="contact-name">
      <input id="contact-name" />
    </FormField>
  );
  expect(screen.getByLabelText("Full name")).toBeInTheDocument();
});

test("required fields show a visible asterisk", () => {
  render(
    <FormField label="Department" htmlFor="dept" required>
      <select id="dept" />
    </FormField>
  );
  expect(screen.getByText("*")).toBeInTheDocument();
});

test("optional fields show no asterisk", () => {
  render(
    <FormField label="Company" htmlFor="company">
      <input id="company" />
    </FormField>
  );
  expect(screen.queryByText("*")).not.toBeInTheDocument();
});

test("an optional hint renders below the field", () => {
  render(
    <FormField label="Value (USD)" htmlFor="value" hint="Optional">
      <input id="value" />
    </FormField>
  );
  expect(screen.getByText("Optional")).toBeInTheDocument();
});
