// test/_chat_cleanup.mjs -- removes leftover Secure Chat TEST organizations (name "chat-<6 hex>-<label>") and everything attached to
// them, e.g. after a seed process was killed before its own teardown. Prints what it removes; --dry-run only lists.
//   node --env-file=.env.local test/_chat_cleanup.mjs [--dry-run]
import { setup, created, teardown, c } from "./_chat-fixtures.mjs";
import { chatDb } from "../src/lib/chat/common.js";

await setup();
const dry = process.argv.includes("--dry-run");
const orgs = await c.orgs.find({ name: { $regex: /^chat-[0-9a-f]{6}-[a-z-]+$/ } }).project({ _id: 1, name: 1 }).toArray();
console.log("test organizations found:", orgs.map((o) => `${o.name} (${o._id})`));
if (dry || !orgs.length) process.exit(0);
created.orgIds.push(...orgs.map((o) => o._id));
const emails = (await c.orgMembers.find({ orgId: { $in: orgs.map((o) => o._id) } }).project({ email: 1 }).toArray()).map((m) => m.email);
created.emails.push(...emails);
await chatDb();
await teardown();
console.log("removed", orgs.length, "organizations and", emails.length, "member rows");
process.exit(0);
