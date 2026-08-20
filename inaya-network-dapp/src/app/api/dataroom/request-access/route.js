// app/api/dataroom/request-access/route.js
//
// POST /api/dataroom/request-access — { name, email } → sends a
// verification magic link (or returns it directly if RESEND_API_KEY
// isn't configured, same fallback convention as orgs/login/request).
// Always returns a generic { sent: true } so this can't be used to
// enumerate which emails have already requested access.

import { NextResponse } from "next/server";
import { validateVisitorInput, requestDataroomAccess } from "../../../../lib/dataroom.js";
import { sendMagicLinkEmail } from "../../../../lib/email.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json();

    let clean;
    try {
      clean = validateVisitorInput(body);
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    const { token } = await requestDataroomAccess(clean);

    const origin = new URL(req.url).origin;
    const verifyUrl = `${origin}/dataroom?token=${token}`;
    const emailResult = await sendMagicLinkEmail({ to: clean.email, url: verifyUrl, purpose: "dataroom_verify" });

    return NextResponse.json({ sent: true, ...(emailResult.sent ? {} : { verifyUrl }) });
  } catch (err) {
    console.error("dataroom/request-access failed:", err);
    return NextResponse.json({ error: "Could not send a verification link. Please try again." }, { status: 500 });
  }
}
