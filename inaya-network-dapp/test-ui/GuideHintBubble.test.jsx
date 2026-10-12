// test-ui/GuideHintBubble.test.jsx
//
// Command Palette + Virtual Guide SOW -- the hint bubble itself. Mocks
// fetch (the per-user voice-prefs GET/PUT) and window.speechSynthesis
// (there is no real implementation in jsdom) so these run without a
// server or a browser's actual TTS engine.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GuideHintBubble from "../src/components/business/ui/GuideHintBubble";

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ readHintsAloud: false }) });
  window.speechSynthesis = { speak: jest.fn(), cancel: jest.fn() };
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
});

test("renders nothing when there is no stuck view", () => {
  const { container } = render(<GuideHintBubble orgId="o1" stuckView={null} onDismiss={() => {}} orgVoiceEnabled={false} />);
  expect(container).toBeEmptyDOMElement();
});

test("renders the hint body for a known view", () => {
  render(<GuideHintBubble orgId="o1" stuckView="procurement" onDismiss={() => {}} orgVoiceEnabled={false} />);
  expect(screen.getByText(/Suppliers, Requests and Orders/)).toBeInTheDocument();
});

test("renders the default hint for an unknown view", () => {
  render(<GuideHintBubble orgId="o1" stuckView="someBrandNewView" onDismiss={() => {}} orgVoiceEnabled={false} />);
  expect(screen.getByText(/jump straight to any page/)).toBeInTheDocument();
});

test("clicking × calls onDismiss", () => {
  const onDismiss = jest.fn();
  render(<GuideHintBubble orgId="o1" stuckView="finance" onDismiss={onDismiss} orgVoiceEnabled={false} />);
  fireEvent.click(screen.getByLabelText("Dismiss hint"));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("click-outside calls onDismiss", () => {
  const onDismiss = jest.fn();
  render(<GuideHintBubble orgId="o1" stuckView="finance" onDismiss={onDismiss} orgVoiceEnabled={false} />);
  fireEvent.mouseDown(document.body);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("'Walk me through it' only renders when the hint has a workflowKey, and calls onStartGuidedTask with it", () => {
  const onStartGuidedTask = jest.fn();
  render(<GuideHintBubble orgId="o1" stuckView="procurement" onDismiss={() => {}} onStartGuidedTask={onStartGuidedTask} orgVoiceEnabled={false} />);
  const button = screen.getByText("Walk me through it");
  fireEvent.click(button);
  expect(onStartGuidedTask).toHaveBeenCalledWith("create_purchase_order");
});

test("no voice toggle shown when org voice is disabled", () => {
  render(<GuideHintBubble orgId="o1" stuckView="finance" onDismiss={() => {}} orgVoiceEnabled={false} />);
  expect(screen.queryByTitle("Read hints aloud")).not.toBeInTheDocument();
});

test("speechSynthesis.speak is NOT called when org voice is on but the user's own preference is off", async () => {
  render(<GuideHintBubble orgId="o1" stuckView="finance" onDismiss={() => {}} orgVoiceEnabled={true} />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
});

test("speechSynthesis.speak IS called when both the org and the user's own preference are on", async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ readHintsAloud: true }) });
  render(<GuideHintBubble orgId="o1" stuckView="finance" onDismiss={() => {}} orgVoiceEnabled={true} />);
  await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1));
});

test("unmounting cancels any in-progress speech", async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ readHintsAloud: true }) });
  const { unmount } = render(<GuideHintBubble orgId="o1" stuckView="finance" onDismiss={() => {}} orgVoiceEnabled={true} />);
  await waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1));
  unmount();
  expect(window.speechSynthesis.cancel).toHaveBeenCalled();
});
