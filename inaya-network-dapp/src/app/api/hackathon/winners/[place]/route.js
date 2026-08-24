// app/api/hackathon/winners/[place]/route.js
//
// DELETE /api/hackathon/winners/[place] — admin-only, clears a previously
// recorded winner for one fixed prize slot (e.g. correcting a mistake
// before mainnet). place must be one of the 6 fixed slot ids from
// src/lib/hackathon.js (1st/2nd/3rd/4th/5th/special).

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth";
import { connectToDatabase } from "../../../../../lib/mongodb";
import { clearWinner } from "../../../../../lib/hackathon";

export async function DELETE(req, { params }) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const { place } = await params;
    const { db } = await connectToDatabase();
    const winners = await clearWinner(db, place);
    return NextResponse.json({ winners });
  } catch (err) {
    console.error("hackathon/winners DELETE failed:", err);
    return NextResponse.json({ error: err.message || "Could not clear winner." }, { status: 400 });
  }
}
