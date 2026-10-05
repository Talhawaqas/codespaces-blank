// test/_vdr_ui_seed.mjs -- a throwaway org with Data Room 2.0 and the secure viewer ON, a room with REAL encrypted files (stored through the real
// storage path), and one visitor invitation, for a real-browser pass. Prints SEED, runs until killed/MAX_MIN, cleans up.
//   node --env-file=.env.local test/_vdr_ui_seed.mjs
import { setup, teardown, makeChatOrg, cookieFor, c } from "./_chat-fixtures.mjs";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { webcrypto, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { getProvider } from "../src/lib/pinningProviders/index.js";
import { createDataRoom } from "../src/lib/external-data-room.js";
import * as V from "../src/lib/dataroom/vdr2.js";
import * as F from "./_viewer_fixtures.mjs";

await setup();
const org = await makeChatOrg("vdrui", { people: ["bob"] });
for (const f of ["FEATURE_DATA_ROOM_V2", "FEATURE_DRM_VIEWER", "FEATURE_ADVANCED_SHARING"]) await setOrgFeature({ orgId: org.oid, name: f, enabled: true });
const passkey = "viewer-test-passkey";
// Workspace format: base64(salt16 | iv12 | AES-256-GCM(PBKDF2-SHA256 100k)) of a data: URL, split across two pinned shards.
async function encryptWorkspace(bytes, mime) {
  const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`; const salt = randomBytes(16), iv = randomBytes(12); const subtle = webcrypto.subtle;
  const km = await subtle.importKey("raw", new TextEncoder().encode(passkey), "PBKDF2", false, ["deriveKey"]); const key = await subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(dataUrl))); const b64 = Buffer.concat([salt, iv, ct]).toString("base64"); const h = Math.floor(b64.length / 2); return [b64.slice(0, h), b64.slice(h)];
}
const provider = getProvider("filebase"); const MIME = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pdf: "application/pdf", png: "image/png", dcm: "application/dicom", md: "text/markdown" };
const files = [["Cap table.xlsx", await F.xlsx(), "Finance"], ["Budget.csv", F.csv(), "Finance"], ["Term sheet.docx", await F.docx(), "Legal"], ["Articles.pdf", F.pdf(), "Legal"], ["Logo.png", F.png(), "Technical"], ["Scan.dcm", F.dicom(), "Technical"], ["Board notes.md", F.markdown(), "Technical"]];
const ids = {};
const dept = new ObjectId(), proj = new ObjectId();
for (const [name, body] of files) {
  const [a, b] = await encryptWorkspace(body, MIME[name.split(".").pop()]); const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pa = await provider.pin(JSON.stringify({ shard: a }), { name: `vdrui-${tag}-a` }); const pb = await provider.pin(JSON.stringify({ shard: b }), { name: `vdrui-${tag}-b` });
  const r = await c.orgDocuments.insertOne({ orgId: org.orgId, departmentId: dept, projectId: proj, filename: name, fileHash: "0xvdr" + tag, sizeBytes: body.length, cidAlpha: pa.cid, cidBeta: pb.cid, uploadedByEmail: org.owner.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", createdAt: new Date().toISOString(), deletedAt: null }); ids[name] = String(r.insertedId);
}
const base = { orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email };
const room = (await createDataRoom({ orgId: org.oid, roomType: "legal", name: "Series A", ndaRequired: true, ndaText: "Everything in this room is confidential.", sections: ["Finance", "Legal", "Technical"], actorEmail: org.owner.email, membership: org.owner.membership })).room;
await V.applyRoomSettings({ ...base, roomId: String(room._id), settings: { watermark: true, defaultPermission: "view", sessionHours: 48, sections: ["Finance", "Legal", "Technical"] } });
for (const sec of ["Finance", "Legal", "Technical"]) await V.bulkAddDocuments({ ...base, roomId: String(room._id), documentIds: files.filter((f) => f[2] === sec).map((f) => ids[f[0]]), section: sec });
await V.updateDocuments({ ...base, roomId: String(room._id), documentIds: [ids["Term sheet.docx"]], patch: { permission: "download" } });
const inv = await V.inviteVisitors({ ...base, roomId: String(room._id), emails: ["investor@fund.com"], role: "downloader" });
console.log("SEED " + JSON.stringify({ orgId: org.oid, roomId: String(room._id), ownerToken: await cookieFor(org.owner.email), passkey, visitorPath: `/room/${inv.invites[0].token}` }));
const stop = async () => { try { await teardown(); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop); setTimeout(stop, (Number(process.env.MAX_MIN) || 40) * 60_000); setInterval(() => {}, 1e6);
