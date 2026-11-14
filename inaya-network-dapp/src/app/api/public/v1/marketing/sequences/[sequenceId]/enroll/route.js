// POST /api/public/v1/marketing/sequences/{id}/enroll { email, name?, company? }   adds a person to a follow-up sequence
// (suppressed addresses and people already in the sequence are skipped; nothing sends until the sequence is approved and active)
import * as Q from "../../../../../../../../lib/engagement/sequences.js";
import { publicRoute } from "../../../../_lib.js";
import { unwrap, gate } from "../../../../_engagement.js";
export const dynamic = "force-dynamic";

export const POST = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, body, params }) => {
  await gate(orgId, "campaigns");
  return unwrap(await Q.enrollMany({ orgId, sequenceId: params.sequenceId, people: [{ email: body.email, name: body.name, company: body.company }], source: "API" }));
});
