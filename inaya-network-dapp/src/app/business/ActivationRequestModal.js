"use client";

// src/app/business/ActivationRequestModal.js
//
// The package activation request form (founder decision, 15 Nov 2026): no card checkout. A company
// owner/admin picks a package, fills in how to reach them and how they will pay (NayaPay or bank
// transfer, for USD and PKR alike), and POSTs /api/orgs/billing/activation-request. The team is
// emailed (filed into the contact@ mailbox's Customers folder) and contacts the company.

import { useEffect, useState } from "react";

const field = "w-full bg-[var(--inaya-input,transparent)] border border-[var(--inaya-overlay-15)] rounded-xl px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]";

export default function ActivationRequestModal({ orgId, plan, extraUsers = 0, pilot = false, onClose, onDone, initialMessage = "" }) {
  const [form, setForm] = useState({ name: "", phone: "", companySize: "", preferredContact: "whatsapp", paymentMethod: "bank_transfer", message: initialMessage || "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const isPkr = plan.currency === "PKR";
  const price = isPkr
    ? `PKR ${Math.round(pilot && plan.pilotMonthly ? plan.pilotMonthly : plan.priceMonthly).toLocaleString("en-US")} / month`
    : `$${plan.priceMonthly} / month`;

  // Professional-only add-ons (src/lib/addOns.js): catalogue in the company's currency, pre-filled with what it already has.
  const [catalogue, setCatalogue] = useState(null); const [businessMonthly, setBusinessMonthly] = useState(null); const [addOns, setAddOns] = useState({});
  useEffect(() => {
    if (plan.id !== "professional") return;
    fetch(`/api/orgs/billing/plans${orgId ? `?orgId=${orgId}` : ""}`, { credentials: "include" }).then((r) => r.json()).then((d) => {
      setCatalogue(d.addOns?.items || []); setBusinessMonthly(d.plans?.find((p) => p.id === "business")?.priceMonthly ?? null);
    }).catch(() => setCatalogue([]));
    if (orgId) fetch(`/api/orgs/billing?orgId=${orgId}`, { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.plan?.id === "professional" && d.plan.addOns) setAddOns(d.plan.addOns); }).catch(() => {});
  }, [plan.id, orgId]);
  const money = (n) => (isPkr ? `PKR ${Math.round(n).toLocaleString("en-US")}` : `$${n}`);
  const addOnTotal = (catalogue || []).reduce((sum, a) => sum + (a.perUnit ? Number(addOns[a.id] || 0) : addOns[a.id] ? 1 : 0) * a.priceMonthly, 0);
  const baseMonthly = pilot && isPkr && plan.pilotMonthly ? plan.pilotMonthly : plan.priceMonthly;
  const total = baseMonthly + addOnTotal;
  const showUpgrade = businessMonthly && addOnTotal > 0 && total >= businessMonthly * 0.85;

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/orgs/billing/activation-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId, planId: plan.id, interval: "month", extraUsers, pilot, paymentMethod: form.paymentMethod, addOns: plan.id === "professional" ? addOns : {},
          contact: { name: form.name, phone: form.phone, companySize: form.companySize || null, preferredContact: form.preferredContact, message: form.message },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not send your request.");
      setDone(true);
      onDone?.(plan);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Request activation">
      <div className="w-full max-w-md bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        {done ? (
          <div className="text-center py-4">
            <p className="text-3xl mb-2" aria-hidden>✅</p>
            <p className="text-[var(--inaya-text-primary)] text-lg font-extrabold">Request sent</p>
            <p className="text-[var(--inaya-text-muted)] text-sm mt-2">Thank you. Our team will contact you within one working day with the payment details. We also emailed you a confirmation. Your workspace opens as soon as the payment arrives and your package is activated.</p>
            <button onClick={onClose} className="mt-5 px-5 py-2.5 rounded-xl text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]">Done</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[var(--inaya-text-primary)] text-lg font-extrabold">Request activation</p>
                <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
                  {plan.name}{extraUsers ? ` + ${extraUsers} extra users` : ""} · {price}{pilot && isPkr && plan.pilotMonthly ? " (pilot price)" : ""}
                </p>
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none">✕</button>
            </div>
            <p className="text-[var(--inaya-text-muted)] text-xs">Fill in your details and our team will contact you to complete the payment. No card needed.</p>

            {plan.id === "professional" && catalogue && catalogue.length > 0 && (
              <fieldset className="border border-[var(--inaya-overlay-15)] rounded-xl p-3 space-y-1.5">
                <legend className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase tracking-wide px-1">Add-ons (optional)</legend>
                {catalogue.map((a) => a.perUnit ? (
                  <label key={a.id} className="flex items-center justify-between gap-2 text-[13px] text-[var(--inaya-text-primary)]">
                    <span>{a.name} <span className="text-[var(--inaya-text-muted)]">{money(a.priceMonthly)}/TB</span></span>
                    <select value={addOns[a.id] || 0} onChange={(e) => setAddOns((x) => ({ ...x, [a.id]: Number(e.target.value) }))} className="bg-transparent border border-[var(--inaya-overlay-15)] rounded-lg px-2 py-1 text-xs" aria-label={a.name}>
                      {Array.from({ length: a.max + 1 }, (_, n) => <option key={n} value={n}>{n ? `+${n} TB` : "None"}</option>)}
                    </select>
                  </label>
                ) : (
                  <label key={a.id} className="flex items-center justify-between gap-2 text-[13px] text-[var(--inaya-text-primary)] cursor-pointer">
                    <span className="flex items-center gap-2"><input type="checkbox" checked={!!addOns[a.id]} onChange={(e) => setAddOns((x) => ({ ...x, [a.id]: e.target.checked }))} />{a.name}</span>
                    <span className="text-[var(--inaya-text-muted)] whitespace-nowrap">{money(a.priceMonthly)}/mo</span>
                  </label>
                ))}
                {addOnTotal > 0 && <p className="text-[12px] text-[var(--inaya-text-primary)] pt-1 font-bold">Total: {money(total)} / month</p>}
                {showUpgrade && <p className="text-[12px] text-amber-500" role="status">{total >= businessMonthly ? `Business is ${money(businessMonthly)} a month and includes all of these, plus 5 TB, 10 users and the admin features.` : `For ${money(businessMonthly - total)} more a month, Business includes all of these, plus 5 TB, 10 users and the admin features.`}</p>}
              </fieldset>
            )}

            <input required value={form.name} onChange={set("name")} placeholder="Your name" className={field} maxLength={120} />
            <input required value={form.phone} onChange={set("phone")} placeholder="Phone / WhatsApp number" className={field} maxLength={40} inputMode="tel" />
            <select value={form.companySize} onChange={set("companySize")} className={field} aria-label="Company size">
              <option value="">Company size (optional)</option>
              {["1-5", "6-20", "21-50", "51-200", "200+"].map((s) => <option key={s} value={s}>{s} people</option>)}
            </select>
            <div>
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase tracking-wide mb-1">Payment method</p>
              <div className="flex gap-2">
                {[["bank_transfer", "Bank transfer"], ["nayapay", "NayaPay"]].map(([v, l]) => (
                  <label key={v} className={`flex-1 text-center cursor-pointer rounded-xl border px-3 py-2 text-sm ${form.paymentMethod === v ? "border-[var(--inaya-accent)] text-[var(--inaya-accent)] bg-[var(--inaya-accent-soft)]" : "border-[var(--inaya-overlay-15)] text-[var(--inaya-text-primary)]"}`}>
                    <input type="radio" name="paymentMethod" value={v} checked={form.paymentMethod === v} onChange={set("paymentMethod")} className="sr-only" />
                    {l}
                  </label>
                ))}
              </div>
            </div>
            <select value={form.preferredContact} onChange={set("preferredContact")} className={field} aria-label="How should we contact you?">
              <option value="whatsapp">Contact me on WhatsApp</option>
              <option value="phone">Call me</option>
              <option value="email">Email me</option>
            </select>
            <textarea value={form.message} onChange={set("message")} placeholder="Anything we should know? (optional)" rows={3} className={field} maxLength={2000} />

            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button disabled={submitting} className="w-full py-2.5 rounded-xl text-sm font-bold bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)] disabled:opacity-50">
              {submitting ? "Sending…" : "Send request"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
