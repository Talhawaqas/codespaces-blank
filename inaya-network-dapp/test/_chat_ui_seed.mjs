// test/_chat_ui_seed.mjs -- seeds a throwaway organization with Secure Chat enabled for a real-browser pass, then keeps "Bob" (a
// real ChatClient device) running so the browser user has someone to talk to. Prints one SEED line, then runs until killed or
// MAX_MIN (default 25) elapses, and cleans everything up on exit.
//   node --env-file=.env.local test/_chat_ui_seed.mjs
import { setup, teardown, makeChatOrg, client, cookieFor } from "./_chat-fixtures.mjs";
import { setOrgFeature } from "../src/lib/featureFlags.js";

await setup();
const org = await makeChatOrg("ui", { people: ["bob", "carol"] });
await setOrgFeature({ orgId: org.oid, name: "FEATURE_SECURE_CHAT", enabled: true });
const ownerToken = await cookieFor(org.owner.email);
const bob = await client(org, org.bob, { label: "Bob laptop" });
const carol = await client(org, org.carol, { label: "Carol laptop" });
console.log("SEED " + JSON.stringify({ orgId: org.oid, ownerEmail: org.owner.email, ownerToken, bob: org.bob.email, carol: org.carol.email }));

const seen = new Set();
let running = true;
const stop = async () => { if (!running) return; running = false; try { await teardown(); } catch { /* ignore */ } process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
setTimeout(stop, (Number(process.env.MAX_MIN) || 25) * 60_000);

while (running) {
  for (const [name, cl] of [["Bob", bob], ["Carol", carol]]) {
    try {
      const r = await cl.sync();
      for (const m of r.fresh) {
        if (m.type !== "msg" || seen.has(m.serverId) || m.from === cl.email) continue;
        seen.add(m.serverId);
        await cl.send(m.conversationId, { text: `${name} here: got "${m.text.slice(0, 60)}"` });
      }
    } catch (e) { console.log(name, "sync error:", e.message); }
  }
  await new Promise((r) => setTimeout(r, 2500));
}
