// src/lib/engagement/messages.js
//
// Appointment Calendar SOW — the customer- and staff-facing messages for the
// booking lifecycle: confirmation (with a calendar invite), reschedule,
// cancellation, reminder (email + SMS), staff notification, enquiry welcome.
// Plain, short wording; every customer email carries the manage link so a
// customer can confirm, move or cancel without signing in.

import { formatInZone } from "./time.js";

export const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL || "https://www.inayanetwork.com").replace(/\/$/, "");
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function shell(title, bodyHtml, footer = "") {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border:1px solid #e3e6eb;border-radius:10px" cellpadding="0" cellspacing="0">
<tr><td style="padding:24px 28px"><h1 style="font-size:20px;margin:0 0 14px">${esc(title)}</h1>${bodyHtml}</td></tr></table>
<p style="font-size:12px;color:#6b7280;max-width:560px">${footer}</p></td></tr></table></body></html>`;
}

const button = (href, label) => `<p style="margin:18px 0"><a href="${esc(href)}" style="background:#0b6e75;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">${esc(label)}</a></p>`;

function whenLines(appt, tz) {
  const zone = tz || appt.timeZone || "UTC";
  const mins = Math.round((new Date(appt.end) - new Date(appt.start)) / 60000);
  return { when: formatInZone(appt.start, zone), mins };
}

function whereText(appt) {
  const l = appt.location || {};
  if (l.joinLink) return `Online: ${l.joinLink}`;
  if (l.kind === "phone") return "By phone, we'll call you";
  if (l.detail) return l.detail;
  return "";
}

export function confirmationEmail({ appt, businessName, manageUrl, pending = false }) {
  const { when, mins } = whenLines(appt);
  const where = whereText(appt);
  const title = pending ? `Request received: ${appt.typeName}` : `Booked: ${appt.typeName}`;
  const intro = pending ? `${businessName} has your request and will confirm it shortly.` : `Your appointment with ${businessName} is booked.`;
  const text = `${intro}\n\n${appt.typeName}\nWhen: ${when} (${mins} min)${where ? `\nWhere: ${where}` : ""}\n\nNeed to change it? ${manageUrl}\n\nThe attached invite adds it to your calendar.`;
  const html = shell(title, `<p>${esc(intro)}</p><p><strong>${esc(appt.typeName)}</strong><br>${esc(when)} (${mins} min)${where ? `<br>${esc(where)}` : ""}</p>${button(manageUrl, "Confirm, reschedule or cancel")}<p style="font-size:13px;color:#6b7280">The attached invite adds it to your calendar.</p>`, `Sent by ${esc(businessName)} through Inaya.`);
  return { subject: title, text, html };
}

export function rescheduleEmail({ appt, businessName, manageUrl, previousStart }) {
  const { when, mins } = whenLines(appt);
  const before = previousStart ? formatInZone(previousStart, appt.timeZone || "UTC") : null;
  const title = `Moved: ${appt.typeName}`;
  const text = `Your appointment with ${businessName} has a new time.\n\nNew time: ${when} (${mins} min)${before ? `\nWas: ${before}` : ""}\n\nManage it: ${manageUrl}`;
  const html = shell(title, `<p>Your appointment with ${esc(businessName)} has a new time.</p><p><strong>${esc(when)}</strong> (${mins} min)${before ? `<br><span style="color:#6b7280">Was ${esc(before)}</span>` : ""}</p>${button(manageUrl, "Manage appointment")}`, `Sent by ${esc(businessName)} through Inaya.`);
  return { subject: title, text, html };
}

export function cancellationEmail({ appt, businessName, rebookUrl, reason }) {
  const { when } = whenLines(appt);
  const title = `Cancelled: ${appt.typeName}`;
  const text = `Your appointment with ${businessName} on ${when} is cancelled.${reason ? `\nReason: ${reason}` : ""}${rebookUrl ? `\n\nBook another time: ${rebookUrl}` : ""}`;
  const html = shell(title, `<p>Your appointment with ${esc(businessName)} on <strong>${esc(when)}</strong> is cancelled.</p>${reason ? `<p>Reason: ${esc(reason)}</p>` : ""}${rebookUrl ? button(rebookUrl, "Book another time") : ""}`, `Sent by ${esc(businessName)} through Inaya.`);
  return { subject: title, text, html };
}

export function reminderEmail({ appt, businessName, manageUrl }) {
  const { when, mins } = whenLines(appt);
  const where = whereText(appt);
  const title = `Reminder: ${appt.typeName}`;
  const text = `A reminder of your appointment with ${businessName}.\n\n${when} (${mins} min)${where ? `\n${where}` : ""}\n\nCan't make it? ${manageUrl}`;
  const html = shell(title, `<p>A reminder of your appointment with ${esc(businessName)}.</p><p><strong>${esc(when)}</strong> (${mins} min)${where ? `<br>${esc(where)}` : ""}</p>${appt.location?.joinLink ? button(appt.location.joinLink, "Join meeting") : ""}<p><a href="${esc(manageUrl)}">Can't make it? Reschedule or cancel</a></p>`, `Sent by ${esc(businessName)} through Inaya.`);
  return { subject: title, text, html };
}

/** 160-character-friendly SMS. */
export function reminderSms({ appt, businessName, manageUrl }) {
  const { when } = whenLines(appt);
  return `${businessName}: reminder of your ${appt.typeName} on ${when}. Manage: ${manageUrl}`.slice(0, 320);
}

export function staffNotificationEmail({ appt, action, staffTz, workspaceUrl }) {
  const { when, mins } = whenLines(appt, staffTz);
  const verb = { booked: "New booking", rescheduled: "Booking moved", cancelled: "Booking cancelled", confirmed: "Booking confirmed" }[action] || "Booking update";
  const who = `${appt.customer?.name || "A customer"}${appt.customer?.email ? ` (${appt.customer.email})` : ""}`;
  const title = `${verb}: ${appt.typeName}`;
  const text = `${verb}.\n\n${who}\n${appt.typeName}, ${when} (${mins} min)${appt.customerNote ? `\nNote from customer: ${appt.customerNote}` : ""}\n\nOpen in Inaya: ${workspaceUrl}`;
  const html = shell(title, `<p>${esc(verb)}.</p><p><strong>${esc(who)}</strong><br>${esc(appt.typeName)}, ${esc(when)} (${mins} min)</p>${appt.customerNote ? `<p>Note from customer: ${esc(appt.customerNote)}</p>` : ""}${button(workspaceUrl, "Open in Inaya")}`);
  return { subject: title, text, html };
}

export function enquiryWelcomeEmail({ name, businessName, bookingUrl, message }) {
  const title = `Thanks for getting in touch with ${businessName}`;
  const greeting = name ? `Hi ${name},` : "Hello,";
  const body = message || `We've received your enquiry and someone from our team will reply soon.`;
  const text = `${greeting}\n\n${body}${bookingUrl ? `\n\nWant to talk sooner? Book a time: ${bookingUrl}` : ""}`;
  const html = shell(title, `<p>${esc(greeting)}</p><p>${esc(body)}</p>${bookingUrl ? button(bookingUrl, "Book a time") : ""}`, `Sent by ${esc(businessName)} through Inaya.`);
  return { subject: title, text, html };
}
