// AI Bookkeeper SOW section 50: /api/orgs/finance/bookkeeper/*. All logic is in src/lib/bookkeeper/api.js; see ../_lib.js for the auth order.
import { bookkeeperRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = bookkeeperRoute;
export const POST = bookkeeperRoute;
export const PATCH = bookkeeperRoute;
export const DELETE = bookkeeperRoute;
