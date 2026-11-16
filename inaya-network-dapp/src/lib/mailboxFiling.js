// src/lib/mailboxFiling.js
//
// Files package activation requests into the "Customers" folder of the contact@inayanetwork.com
// mailbox (founder request, 15 Nov 2026). Hostinger Mail has no filter-rule API, so this uses its
// REST API directly: search INBOX and Junk for the fixed subject tag and move each match. It is called right
// after a request is emailed (with a few retries, since delivery takes a moment) and by the
// engagement cron as a safety net. Needs HOSTINGER_MAIL_API_TOKEN; without it this is a no-op.

import { ACTIVATION_INBOX, ACTIVATION_SUBJECT_TAG } from "./billingRequests.js";

const API = "https://api.mail.hostinger.com/api/v1";
export const CUSTOMERS_FOLDER = "Customers";

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${String(process.env.HOSTINGER_MAIL_API_TOKEN).trim()}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Hostinger Mail API ${method} ${path.split("?")[0]} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/** Moves every tagged activation request still in INBOX to the Customers folder. Returns how many moved. */
export async function fileActivationRequests() {
  if (!process.env.HOSTINGER_MAIL_API_TOKEN) return { moved: 0, skipped: "HOSTINGER_MAIL_API_TOKEN not set" };
  const me = await call("/me");
  const mailbox = (me?.data?.mailboxes || []).find((m) => String(m.address || m.email || "").toLowerCase() === ACTIVATION_INBOX.toLowerCase());
  if (!mailbox) return { moved: 0, skipped: `token has no access to ${ACTIVATION_INBOX}` };
  const id = encodeURIComponent(mailbox.resourceId);
  let moved = 0;
  // Junk too: Hostinger's spam filter can divert these automated emails (seen in the first live test).
  for (const folder of ["INBOX", "Junk"]) {
    const found = await call(`/mailboxes/${id}/folders/${folder}/messages/search?page=1&perPage=50`, { method: "POST", body: { subject: ACTIVATION_SUBJECT_TAG } });
    const messages = (found?.data || []).filter((m) => String(m.subject || "").includes(ACTIVATION_SUBJECT_TAG));
    for (const m of messages) {
      await call(`/mailboxes/${id}/folders/${folder}/messages/${encodeURIComponent(m.uid)}/move`, { method: "POST", body: { targetFolder: CUSTOMERS_FOLDER } });
      moved++;
    }
  }
  return { moved };
}

/** Right after sending: retries for a short while, because the email takes a few seconds to arrive. */
export async function fileActivationRequestsSoon({ attempts = 6, delayMs = 5000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const r = await fileActivationRequests();
      if (r.skipped || r.moved > 0) return r;
    } catch (err) {
      console.error("mailboxFiling: filing attempt failed:", err.message);
    }
  }
  return { moved: 0 };
}
