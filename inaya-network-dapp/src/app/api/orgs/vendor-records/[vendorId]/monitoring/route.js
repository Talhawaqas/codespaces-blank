// app/api/orgs/vendor-records/[vendorId]/monitoring/route.js
// PATCH { orgId, action: "subprocessorChange" | "expiryDates", ... } -> §66 continuous monitoring updates

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { recordSubprocessorChange, updateVendorExpiryDates } from "../../../../../../lib/vendor-management.js";

export async function PATCH(req, { params }) {
  try {
    const { vendorId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let result;
    if (action === "subprocessorChange") {
      result = await recordSubprocessorChange({ ...body, vendorId, actorEmail: auth.session.email, membership: auth.membership });
    } else if (action === "expiryDates") {
      result = await updateVendorExpiryDates({ ...body, vendorId, actorEmail: auth.session.email, membership: auth.membership });
    } else {
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ vendor: { id: result.vendor._id.toString(), subprocessorChangeLog: result.vendor.subprocessorChangeLog, certificateExpiryDates: result.vendor.certificateExpiryDates, contractExpiryDate: result.vendor.contractExpiryDate } });
  } catch (err) {
    console.error("orgs/vendor-records/[vendorId]/monitoring PATCH failed:", err);
    return NextResponse.json({ error: "Could not update vendor monitoring data." }, { status: 500 });
  }
}
