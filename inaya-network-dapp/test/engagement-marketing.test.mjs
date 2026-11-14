// Mass Marketing Email SOW — pure logic: templates/merge fields, rendering safety, signed links,
// schedules/recurrence, segment rules, provider payload (unsubscribe headers, tracking).
import test from "node:test";
import assert from "node:assert/strict";
process.env.INTEGRATION_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
process.env.MARKETING_EMAIL_FROM = "news@mail.example.com";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

const T = await import("../src/lib/engagement/templates.js");
const S = await import("../src/lib/engagement/suppression.js");
const C = await import("../src/lib/engagement/campaigns.js");
const G = await import("../src/lib/engagement/segments.js");
const X = await import("../src/lib/engagement/sender.js");

test("merge fields with fallbacks, HTML escaping", () => {
  assert.equal(T.mergeText("Hi {{first_name|there}}!", { first_name: "" }), "Hi there!");
  assert.equal(T.mergeText("Hi {{ first_name }}", { first_name: "Ali" }), "Hi Ali");
  assert.equal(T.mergeText("{{unknown}}x", {}), "x");
  assert.equal(T.mergeText("{{name}}", { name: "<b>" }, { html: true }), "&lt;b&gt;");
});

test("blocks are validated and render safely (no script, https only)", () => {
  assert.ok(T.validateBlocks([]).error);
  assert.ok(T.validateBlocks([{ type: "script" }]).error);
  assert.ok(T.validateBlocks([{ type: "button", label: "x", url: "javascript:alert(1)" }]).error);
  assert.ok(T.validateBlocks([{ type: "image", src: "http://x.com/a.png" }]).error);
  assert.ok(!T.validateBlocks([{ type: "button", label: "Book", url: "{{booking_url}}" }]).error);
  const { blocks } = T.validateBlocks([{ type: "heading", text: "Hello {{first_name}}" }, { type: "text", text: "<script>x</script> **bold** [site](https://a.com/?q=1&b=2)" }, { type: "button", label: "Go", url: "https://b.com" }]);
  const r = T.renderEmail({ blocks, vars: { first_name: "Sara" }, linkWrap: (u) => `https://t/${encodeURIComponent(u)}`, footer: { businessName: "Acme", postalAddress: "1 Road", unsubscribeUrl: "https://u" } });
  assert.ok(r.html.includes("Hello Sara"));
  assert.ok(!r.html.includes("<script>"));
  assert.ok(r.html.includes("<strong>bold</strong>"));
  assert.ok(r.html.includes("https://t/https%3A%2F%2Fa.com%2F%3Fq%3D1%26b%3D2"), "inline link wrapped with original & intact");
  assert.ok(r.html.includes("https://t/https%3A%2F%2Fb.com"));
  assert.ok(r.html.includes("1 Road") && r.html.includes("Unsubscribe"));
  assert.ok(r.text.includes("Unsubscribe: https://u") && r.text.includes("Go: https://b.com"));
});

test("all five starter templates are valid", () => {
  assert.equal(T.STARTER_TEMPLATES.length, 5);
  for (const t of T.STARTER_TEMPLATES) assert.ok(!T.validateBlocks(t.blocks).error, t.key);
});

test("signed tokens and click signatures", () => {
  const id = "65a1b2c3d4e5f6a7b8c9d0e1";
  const tok = S.signToken("u", id);
  assert.equal(S.verifyToken("u", tok), id);
  assert.equal(S.verifyToken("o", tok), null, "purpose-bound");
  assert.equal(S.verifyToken("u", tok.slice(0, -1) + (tok.endsWith("A") ? "B" : "A")), null);
  assert.equal(S.verifyToken("u", "not-a-token"), null);
  const sig = S.signClick(id, "https://a.com");
  assert.ok(S.verifyClick(id, "https://a.com", sig));
  assert.ok(!S.verifyClick(id, "https://evil.com", sig), "can't reuse a signature as an open redirect");
});

test("schedules and recurrence", () => {
  assert.ok(C.normalizeSchedule({ sendAt: "2020-01-01" }).error);
  assert.ok(C.normalizeSchedule({ recurrence: { freq: "weekly" } }).error, "needs an end");
  const ok = C.normalizeSchedule({ sendAt: new Date(Date.now() + 3600000).toISOString(), recurrence: { freq: "weekly", interval: 2, maxRuns: 3 } });
  assert.ok(!ok.error);
  const r = ok.schedule.recurrence;
  assert.equal(C.nextRunAfter(r, "2026-11-16T09:00:00Z").toISOString(), "2026-11-30T09:00:00.000Z");
  assert.equal(C.nextRunAfter({ ...r, runsDone: 2 }, "2026-11-16T09:00:00Z"), null, "third run is the last");
  assert.equal(C.nextRunAfter({ freq: "monthly", interval: 1, until: "2026-12-01T00:00:00Z" }, "2026-11-16T09:00:00Z"), null);
});

test("segment rules", () => {
  assert.ok(G.normalizeRules({ emailDomain: "not a domain" }).error);
  assert.ok(G.normalizeRules({ inactiveDays: 0 }).error);
  const { rules } = G.normalizeRules({ contactTypes: ["LEAD", "X"], inactiveDays: 90, appointment: "completed_recently", consentedOnly: true });
  assert.deepEqual(rules.contactTypes, ["LEAD"]);
  assert.equal(rules.completedWithinDays, 30);
  assert.match(G.describeRules(rules), /Leads, with no CRM activity in 90 days/);
});

test("provider payload: one-click unsubscribe, tracking, personalisation", () => {
  const send = { _id: "65a1b2c3d4e5f6a7b8c9d0e1", email: "sara@example.com", name: "Sara Khan", company: "Ex" };
  const content = { subject: "Hi {{first_name}}", preheader: "", blocks: [{ type: "text", text: "Visit [us](https://acme.com)" }] };
  const m = X.buildMessage({ send, content, settings: { ...S.MARKETING_DEFAULTS, fromName: "Acme", postalAddress: "1 Road", replyTo: "hi@acme.com" } });
  assert.equal(m.from, "Acme <news@mail.example.com>");
  assert.equal(m.subject, "Hi Sara");
  assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(m.headers["List-Unsubscribe"], /^<https:\/\/app\.example\.com\/api\/m\/unsubscribe\/65a1b2c3d4e5f6a7b8c9d0e1\./);
  assert.ok(m.html.includes("https://app.example.com/api/m/o/65a1b2c3d4e5f6a7b8c9d0e1."), "open pixel");
  assert.ok(m.html.includes("/api/m/c/65a1b2c3d4e5f6a7b8c9d0e1."), "click tracking");
  assert.ok(m.html.includes("https://app.example.com/u/65a1b2c3d4e5f6a7b8c9d0e1."), "footer unsubscribe page");
  assert.equal(m.reply_to, "hi@acme.com");
  assert.equal(X.senderStatus().configured, !!(process.env.RESEND_MARKETING_API_KEY || process.env.RESEND_API_KEY));
});
