// app/api/admin/dataroom/documents/route.js
//
// GET  /api/admin/dataroom/documents — list all data room documents.
// POST /api/admin/dataroom/documents — upload a new one (multipart:
//   file, title, category). Pins the raw file to Pinata (unencrypted —
//   see src/lib/dataroom.js's header comment for why) and registers it.
//
// Gated by the current Enterprise Dashboard admin session
// (isAdminAuthenticated), same as /api/admin/customers etc. — not the
// older ?key= pattern /api/admin/feedback still uses.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { ensureDataroomIndexes, getDataroomCollections, validateDocumentUploadInput, pinDocumentFile } from "../../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    await ensureDataroomIndexes();
    const { documents } = await getDataroomCollections();
    const items = await documents.find({}).sort({ order: 1, uploadedAt: 1 }).toArray();

    return NextResponse.json({
      items: items.map((d) => ({ ...d, _id: d._id.toString() })),
    });
  } catch (err) {
    console.error("admin/dataroom/documents GET failed:", err);
    return NextResponse.json({ error: "Could not load documents." }, { status: 500 });
  }
}

export async function POST(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const title = formData.get("title");
    const category = formData.get("category");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "A file is required." }, { status: 400 });
    }

    let clean;
    try {
      clean = validateDocumentUploadInput({ title, category, sizeBytes: file.size, mimeType: file.type });
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const cid = await pinDocumentFile({ buffer, filename: file.name, mimeType: file.type });

    await ensureDataroomIndexes();
    const { documents } = await getDataroomCollections();
    const count = await documents.countDocuments({});
    const { insertedId } = await documents.insertOne({
      title: clean.title,
      category: clean.category,
      filename: file.name,
      cid,
      sizeBytes: file.size,
      mimeType: file.type,
      uploadedAt: new Date().toISOString(),
      order: count,
    });

    return NextResponse.json({ id: insertedId.toString() });
  } catch (err) {
    console.error("admin/dataroom/documents POST failed:", err);
    return NextResponse.json({ error: err.message || "Upload failed." }, { status: 500 });
  }
}
