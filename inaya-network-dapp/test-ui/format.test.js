// test-ui/format.test.js
//
// Business Workspace UX/UI Makeover SOW -- formatCurrency/formatDate
// replace hand-written formatting duplicated 46 times across 19 files
// (see BUSINESS_WORKSPACE_UX_AUDIT.md #3.1). These pin the exact output
// shape the original call sites already produced.

import { formatDate, formatDateTime, formatCurrency, formatNumber } from "../src/lib/format";

test("formatDate matches the original toLocaleDateString() call sites", () => {
  const iso = "2026-03-15T00:00:00.000Z";
  expect(formatDate(iso)).toBe(new Date(iso).toLocaleDateString());
});

test("formatDate handles missing/invalid input safely", () => {
  expect(formatDate(null)).toBe("—");
  expect(formatDate(undefined)).toBe("—");
  expect(formatDate("not-a-date")).toBe("—");
});

test("formatDateTime matches toLocaleString()", () => {
  const iso = "2026-03-15T14:30:00.000Z";
  expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString());
});

test("formatCurrency matches the original `${currency} ${amount.toFixed(2)}` pattern", () => {
  expect(formatCurrency(1234.5, "USD")).toBe("USD 1234.50");
  expect(formatCurrency(0, "USD")).toBe("USD 0.00");
  expect(formatCurrency(99, "EUR")).toBe("EUR 99.00");
});

test("formatCurrency without a currency omits the prefix", () => {
  expect(formatCurrency(42)).toBe("42.00");
});

test("formatCurrency handles non-numeric input safely, never NaN", () => {
  expect(formatCurrency(undefined, "USD")).toBe("USD 0.00");
  expect(formatCurrency(null, "USD")).toBe("USD 0.00");
  expect(formatCurrency("not a number", "USD")).toBe("USD 0.00");
});

test("formatNumber adds thousands separators", () => {
  expect(formatNumber(1234567)).toBe((1234567).toLocaleString());
});

test("formatNumber handles non-numeric input safely", () => {
  expect(formatNumber(null)).toBe("—");
  expect(formatNumber("x")).toBe("—");
});
