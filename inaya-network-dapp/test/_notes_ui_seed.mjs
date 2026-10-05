// test/_notes_ui_seed.mjs -- throwaway org with Secure Notes ON and a second member who already has a notes vault, for a real-browser pass.
// Prints SEED, runs until killed/MAX_MIN, cleans up. Passphrase of the colleague: "colleague passphrase".
//   node --env-file=.env.local test/_notes_ui_seed.mjs
import { setup, teardown, makeChatOrg, cookieFor } from "./_chat-fixtures.mjs";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { createVault } from "../src/lib/notes/notes.js";
import { createVaultKeys } from "../src/lib/notes/client/crypto.js";

await setup();
const org = await makeChatOrg("notesui", { people: ["bob"] });
await setOrgFeature({ orgId: org.oid, name: "FEATURE_SECURE_NOTES", enabled: true });
await createVault({ orgId: org.oid, email: org.bob.email, vault: (await createVaultKeys("colleague passphrase")).vault });
console.log("SEED " + JSON.stringify({ orgId: org.oid, ownerEmail: org.owner.email, bob: org.bob.email, ownerToken: await cookieFor(org.owner.email) }));
const stop = async () => { try { await teardown(); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
setTimeout(stop, (Number(process.env.MAX_MIN) || 25) * 60_000);
setInterval(() => {}, 1e6);
