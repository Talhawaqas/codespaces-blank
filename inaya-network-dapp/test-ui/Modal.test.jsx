// test-ui/Modal.test.jsx
//
// Business Workspace UX/UI Makeover SOW -- Modal was hand-copied 12 times
// across the Workspace's view files (see BUSINESS_WORKSPACE_UX_AUDIT.md
// #3.1); this is the one real test suite it needed and never had.

import { render, screen, fireEvent } from "@testing-library/react";
import Modal from "../src/components/business/ui/Modal";

test("renders the title and children", () => {
  render(
    <Modal title="New contact" onClose={() => {}}>
      <p>form goes here</p>
    </Modal>
  );
  expect(screen.getByText("New contact")).toBeInTheDocument();
  expect(screen.getByText("form goes here")).toBeInTheDocument();
});

test("clicking the backdrop calls onClose", () => {
  const onClose = jest.fn();
  const { container } = render(
    <Modal title="Test" onClose={onClose}>
      <p>content</p>
    </Modal>
  );
  fireEvent.click(container.firstChild);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("clicking inside the panel does NOT call onClose (stopPropagation)", () => {
  const onClose = jest.fn();
  render(
    <Modal title="Test" onClose={onClose}>
      <p>content</p>
    </Modal>
  );
  fireEvent.click(screen.getByText("content"));
  expect(onClose).not.toHaveBeenCalled();
});

test("clicking the close (×) button calls onClose", () => {
  const onClose = jest.fn();
  render(
    <Modal title="Test" onClose={onClose}>
      <p>content</p>
    </Modal>
  );
  fireEvent.click(screen.getByLabelText("Close"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("wide prop widens the panel", () => {
  const { container: narrow } = render(<Modal title="A" onClose={() => {}}>x</Modal>);
  const { container: wide } = render(<Modal title="B" onClose={() => {}} wide>x</Modal>);
  expect(narrow.querySelector(".max-w-md")).toBeTruthy();
  expect(wide.querySelector(".max-w-lg")).toBeTruthy();
});
