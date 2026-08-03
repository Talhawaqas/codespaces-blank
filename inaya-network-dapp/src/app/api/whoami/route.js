// app/api/whoami/route.js
//
// GET /api/whoami
//
// Reads the http-only cookie set by resolve-checkout-session. The
// Dashboard calls this on every load (not just right after checkout) so
// a card customer returning days later is still recognized without
// connecting a wallet or re-entering their email.

import { NextResponse } from "next/server";

export async function GET(req) {
  const email = req.cookies.get("inaya_customer_email")?.value || null;
  return NextResponse.json({ email });
}