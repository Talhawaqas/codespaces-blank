// app/api/orgs/s3-compat/sas/route.js
//
// POST /api/orgs/s3-compat/sas -- body: { orgId, accessKeyId, container, blob?, permissions, expiresInMinutes? }
//
// Mints an Azure Shared Access Signature URL for one of this organization's existing S3/Azure
// credentials, ready to paste into AzCopy or an Azure SDK (see lib/s3-compat/azureSas.js). With `blob`
// the SAS covers that one blob; without it, the whole container. The raw secret is not needed: the
// credential's secret is stored wrapped and only unwrapped here, server-side, to sign.
//
// Owner/admin only (the same gate as issuing a credential). The SAS can never exceed its signing
// credential: when it's used, the credential's own stored scope is enforced on top of the SAS's
// permissions, and revoking the credential invalidates every SAS it signed.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg } from "../../../../../lib/orgs.js";
import { resolveS3Credential } from "../../../../../lib/s3-compat/credentials.js";
import { signServiceSas, MAX_SAS_LIFETIME_MS } from "../../../../../lib/s3-compat/azureSas.js";

const BLOB_PERMISSIONS = new Set(["r", "a", "c", "w", "d"]);
const CONTAINER_PERMISSIONS = new Set(["r", "a", "c", "w", "d", "l"]);
const ORDER = "racwdl"; // the order Azure expects permission letters in

export async function POST(req) {
  try {
    const { orgId, accessKeyId, container, blob = null, permissions, expiresInMinutes = 60 } = await req.json();
    if (!orgId || !accessKeyId || !container || !permissions) {
      return NextResponse.json({ error: "orgId, accessKeyId, container and permissions are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can create a SAS URL." }, { status: 403 });

    const allowed = blob ? BLOB_PERMISSIONS : CONTAINER_PERMISSIONS;
    const letters = [...new Set(String(permissions).toLowerCase().split(""))];
    if (!letters.length || letters.some((l) => !allowed.has(l))) {
      return NextResponse.json({ error: `permissions must be letters from "${[...allowed].join("")}" for a ${blob ? "blob" : "container"} SAS.` }, { status: 400 });
    }
    const minutes = Number(expiresInMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes * 60_000 > MAX_SAS_LIFETIME_MS) {
      return NextResponse.json({ error: "expiresInMinutes must be between 1 and 10080 (7 days)." }, { status: 400 });
    }

    const credential = await resolveS3Credential(accessKeyId);
    // A credential belonging to another organization is reported exactly like a missing one.
    if (!credential || credential.owner.type !== "org" || credential.owner.orgId !== String(orgId)) {
      return NextResponse.json({ error: "No active credential with that accessKeyId in this organization." }, { status: 404 });
    }

    const expiresAt = Date.now() + minutes * 60_000;
    const query = signServiceSas({
      accountName: credential.accessKeyId,
      accountKeyBase64: Buffer.from(credential.secretAccessKey, "utf8").toString("base64"),
      container,
      blob: blob || null,
      permissions: [...ORDER].filter((l) => letters.includes(l)).join(""),
      expiresAt,
    });
    const path = [container, ...(blob ? blob.split("/") : [])].map(encodeURIComponent).join("/");
    return NextResponse.json({
      url: `${new URL(req.url).origin}/api/azure/${path}?${query}`,
      expiresAt: new Date(expiresAt).toISOString(),
      note: "Works with AzCopy and Azure SDKs. The inaya-account parameter is required by this endpoint and must be kept in the URL.",
    });
  } catch (err) {
    console.error("orgs/s3-compat/sas POST failed:", err);
    return NextResponse.json({ error: "Could not create the SAS URL." }, { status: 500 });
  }
}
