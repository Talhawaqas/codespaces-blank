// src/lib/ics.js
//
// Minimal RFC 5545 calendar invite (one VEVENT, METHOD:REQUEST) that
// Outlook, Google Calendar and Apple Calendar all accept. Text is escaped
// and lines are folded at 75 octets as the RFC requires.

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}${pad(x.getUTCSeconds())}Z`;
};
export const escapeIcsText = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // never split a multi-byte UTF-8 character
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines start with a space
  }
  return parts.join("\r\n ");
}

/** Builds an invite. start: Date|ISO; durationMinutes: 5..1440. */
export function buildInvite({ uid, start, durationMinutes = 30, summary, description, location, organizerEmail, organizerName, attendees = [], now = new Date() }) {
  const begin = new Date(start);
  if (Number.isNaN(begin.getTime())) throw new Error("Invalid meeting start time.");
  const end = new Date(begin.getTime() + durationMinutes * 60000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Inaya Network//Business Workspace//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(begin)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    ...(description ? [`DESCRIPTION:${escapeIcsText(description)}`] : []),
    ...(location ? [`LOCATION:${escapeIcsText(location)}`] : []),
    ...(organizerEmail ? [`ORGANIZER;CN=${escapeIcsText(organizerName || organizerEmail)}:mailto:${organizerEmail}`] : []),
    ...attendees.map((a) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${escapeIcsText(a.name || a.email)}:mailto:${a.email}`),
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
