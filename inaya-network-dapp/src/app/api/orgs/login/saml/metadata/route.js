// app/api/orgs/login/saml/metadata/route.js -- GET ?orgId=  the SAML service-provider metadata XML for a company that uses
// SAML SSO (entity id and reply address; public, no secrets). Identity providers can import it instead of typing the values.
import { NextResponse } from "next/server";
import { samlMetadata } from "../../../../../../lib/workforceSso.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const orgId = new URL(req.url).searchParams.get("orgId") || "";
  if (!/^[0-9a-f]{24}$/i.test(orgId)) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
  try {
    const xml = await samlMetadata(orgId);
    if (!xml) return NextResponse.json({ error: "This company does not use SAML single sign-on." }, { status: 404 });
    return new NextResponse(xml, { headers: { "Content-Type": "application/samlmetadata+xml; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  } catch (err) { console.error("saml metadata failed:", err?.name); return NextResponse.json({ error: "Something went wrong." }, { status: 500 }); }
}
