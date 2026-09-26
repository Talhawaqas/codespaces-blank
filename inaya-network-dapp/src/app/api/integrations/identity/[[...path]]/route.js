// Identity Integration SOW section 43: /api/integrations/identity/*. All logic is in src/lib/identity/api.js; see ../_lib.js for the auth order.
import { identityRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = identityRoute;
export const POST = identityRoute;
export const PATCH = identityRoute;
export const DELETE = identityRoute;
