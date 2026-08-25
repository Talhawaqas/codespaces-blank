// src/lib/email.js
//
// Transactional email via Resend's REST API (https://resend.com) — plain
// fetch, no SDK dependency needed for a single endpoint. Chosen over
// SMTP/nodemailer for a serverless Next.js app: no persistent connection
// to manage, a generous free tier, and a single API key to configure.
//
// Requires RESEND_API_KEY in .env.local (get one from resend.com — free
// tier covers this comfortably) and a verified sending domain set as
// EMAIL_FROM, e.g. "Inaya Network <noreply@inayanetwork.com>". Until
// RESEND_API_KEY is set, sendEmail() no-ops and logs a warning rather than
// failing the request — every caller in this codebase (org auth, referral
// invites) already returns the link directly in its JSON response as a
// fallback, so missing email config degrades to "share the link manually"
// instead of breaking anything.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM || "Inaya Network <onboarding@resend.dev>";

export async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.warn(`sendEmail: RESEND_API_KEY not set — skipping real delivery to ${to}. Set RESEND_API_KEY in .env.local to enable.`);
    return { sent: false, reason: "not_configured" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html, text }),
    });
    if (!res.ok) {
      // Status only — never the response body, this call carries our API key
      // and a failure response could echo back account-identifying details.
      console.error(`sendEmail: Resend API returned ${res.status} for ${to}`);
      return { sent: false, reason: "provider_error" };
    }
    return { sent: true };
  } catch (err) {
    console.error("sendEmail: request to Resend failed:", err.message);
    return { sent: false, reason: "network_error" };
  }
}

const BRAND_HEADER = `
  <div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 480px; margin: 0 auto;">
    <div style="padding: 24px 0 8px; font-weight: 800; font-size: 18px; letter-spacing: 0.5px; color: #10151f;">
      INAYA <span style="color: #007a8f;">NETWORK</span>
    </div>
`;
// "Expires in 30 minutes, one-time use" is only true for this app's own
// magic-link tokens (login/invite/dataroom_verify) -- the referral purpose
// links to a Didit-hosted KYC session instead, which this app doesn't
// control the expiry of and reuses across repeat calls (see
// api/referrals/initiate's existingReferral.diditSessionUrl reuse), so
// that claim would be inaccurate for referral emails specifically.
function brandFooter({ isReferral } = {}) {
  const expiryNote = isReferral
    ? "If you weren't expecting this, you can ignore this email."
    : "This link expires in 30 minutes and can only be used once. If you didn't request it, you can ignore this email.";
  return `
    <p style="margin-top: 32px; font-size: 12px; color: #8a93a3;">
      ${expiryNote}
    </p>
  </div>
`;
}

/** The one email template every magic-link flow in this codebase sends (org login,
 *  org invite, data room access verification, and reusable for anything else
 *  that's just "click to continue"). */
export async function sendMagicLinkEmail({ to, url, purpose = "login", orgName, referrerEmail, documentLabel }) {
  const isInvite = purpose === "invite";
  const isDataroom = purpose === "dataroom_verify";
  const isReferral = purpose === "referral";
  const isApprovalNotify = purpose === "approval_notify";
  const subject = isInvite
    ? `You've been invited to join ${orgName} on Inaya`
    : isDataroom
      ? "Verify your email to access the Inaya data room"
      : isReferral
        ? "You've been invited to Inaya Network"
        : isApprovalNotify
          ? `Pending your approval — ${orgName}`
          : "Your Inaya sign-in link";
  const heading = isInvite
    ? `Join ${orgName} on Inaya`
    : isDataroom
      ? "Access the Inaya Data Room"
      : isReferral
        ? "You're invited to Inaya Network"
        : isApprovalNotify
          ? "A document needs your approval"
          : "Sign in to Inaya";
  const body = isInvite
    ? `You've been invited to join <b>${orgName}</b>. Click below to accept the invite and sign in.`
    : isDataroom
      ? "Click below to verify your email and continue to the data room."
      : isReferral
        ? `${referrerEmail ? `<b>${referrerEmail}</b> thinks` : "Someone thinks"} you'd like Inaya — a private, encrypted vault for your files, with no single company (not even Inaya) ever holding a readable copy. Click below to verify your identity and get started.`
        : isApprovalNotify
          ? `<b>${documentLabel || "A document"}</b> was just submitted in <b>${orgName}</b> and is waiting on your review. Click below to sign in and take a look.`
          : "Click below to sign in — no password needed.";

  const html = `
    ${BRAND_HEADER}
    <h1 style="font-size: 20px; margin: 16px 0 8px; color: #10151f;">${heading}</h1>
    <p style="font-size: 14px; line-height: 1.6; color: #3a4250;">${body}</p>
    <a href="${url}" style="display: inline-block; margin: 16px 0; padding: 12px 22px; background: #007a8f; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
      ${isInvite ? "Accept invite" : isDataroom ? "Verify & continue" : isReferral ? "Verify & get started" : isApprovalNotify ? "Review document" : "Sign in"}
    </a>
    <p style="font-size: 12px; color: #8a93a3; word-break: break-all;">${url}</p>
    ${brandFooter({ isReferral })}
  `;
  const text = `${heading}\n\n${body.replace(/<[^>]+>/g, "")}\n\n${url}`;

  return sendEmail({ to, subject, html, text });
}
