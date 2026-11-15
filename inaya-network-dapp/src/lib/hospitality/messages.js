// src/lib/hospitality/messages.js
//
// Transactional guest emails for reservations (SOW 24). These are operational messages: they never carry
// marketing content, so they don't depend on marketing consent. Each returns { subject, html, text }.

import { appUrl, esc } from "../engagement/messages.js";
import { formatInZone } from "../engagement/time.js";

const shell = (title, body, footer = "") => `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#ffffff;border-radius:10px;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${body}</div>
<p style="font-size:12px;color:#6b7280;margin:14px 4px">${footer}</p></div></body></html>`;
const button = (href, label) => `<p style="margin:18px 0"><a href="${esc(href)}" style="background:#0b6e75;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">${esc(label)}</a></p>`;
const p = (s) => `<p style="font-size:15px;line-height:1.5;margin:0 0 10px">${s}</p>`;

export const manageUrl = (token) => `${appUrl()}/reserve/manage/${token}`;

function details(r, location) {
  const when = formatInZone(r.start, location.timeZone);
  const lines = [`${r.partySize} ${r.partySize === 1 ? "guest" : "guests"}`, when, location.name + (location.address ? `, ${location.address}` : "")];
  return { when, html: `<table style="font-size:15px;margin:6px 0 12px">${lines.map((l) => `<tr><td style="padding:2px 0">${esc(l)}</td></tr>`).join("")}</table>`, text: lines.join("\n") };
}

const foot = (business, location) => `Sent by ${esc(business)}${location.phone ? ` · ${esc(location.phone)}` : ""}. This is a message about your reservation, not a marketing email.`;

export function reservationEmail({ kind, r, location, business, token, reason }) {
  const d = details(r, location);
  const url = token ? manageUrl(token) : null;
  const policy = location.policy?.policyText ? p(esc(location.policy.policyText)) : "";
  const T = {
    confirmed: { subject: `Reservation confirmed: ${business}, ${d.when}`, title: "Your reservation is confirmed", lead: `Thank you, ${esc(r.guest.name)}. We look forward to seeing you.` },
    pending: { subject: `Reservation request received: ${business}`, title: "We've received your request", lead: `Thank you, ${esc(r.guest.name)}. This isn't confirmed yet. We'll email you as soon as the team has confirmed it.` },
    changed: { subject: `Reservation changed: ${business}, ${d.when}`, title: "Your reservation has changed", lead: `Hello ${esc(r.guest.name)}, here are the new details.` },
    cancelled: { subject: `Reservation cancelled: ${business}`, title: "Your reservation is cancelled", lead: `Hello ${esc(r.guest.name)}, this reservation has been cancelled.${reason ? ` Reason: ${esc(reason)}.` : ""}` },
    declined: { subject: `Reservation request: ${business}`, title: "We couldn't confirm your request", lead: `Hello ${esc(r.guest.name)}, we're sorry, we can't offer this time.${reason ? ` ${esc(reason)}` : ""}` },
    reminder: { subject: `Reminder: ${business}, ${d.when}`, title: "A reminder of your reservation", lead: `Hello ${esc(r.guest.name)}, we're looking forward to seeing you.` },
  }[kind];
  const canManage = url && ["confirmed", "pending", "changed", "reminder"].includes(kind);
  const html = shell(T.title, `${p(T.lead)}${d.html}${p(`Reference: <strong>${esc(r.ref)}</strong>`)}${["confirmed", "pending", "changed"].includes(kind) ? policy : ""}${canManage ? button(url, "View or cancel reservation") : ""}`, foot(business, location));
  const text = `${T.title}\n\n${T.lead.replace(/<[^>]+>/g, "")}\n\n${d.text}\nReference: ${r.ref}${canManage ? `\n\nView or cancel: ${url}` : ""}\n\n${business}`;
  return { subject: T.subject, html, text };
}

export function waitlistInviteEmail({ entry, location, business, holdMinutes }) {
  const html = shell("Your table is ready", `${p(`Hello ${esc(entry.guest.name)}, a table for ${entry.partySize} is now available at ${esc(location.name)}.`)}${p(`Please come to the host stand${holdMinutes ? ` within ${holdMinutes} minutes` : ""}.`)}`, foot(business, location));
  return { subject: `Your table is ready: ${business}`, html, text: `Hello ${entry.guest.name}, a table for ${entry.partySize} is now available at ${location.name}. Please come to the host stand${holdMinutes ? ` within ${holdMinutes} minutes` : ""}.\n\n${business}` };
}
