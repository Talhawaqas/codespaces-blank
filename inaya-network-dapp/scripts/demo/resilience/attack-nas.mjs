// scripts/demo/resilience/attack-nas.mjs -- the controlled, ransomware-LIKE simulation against the demo NAS share (SOW Workstream B,
// Stage 2). NOT malware: a real SMB client (smbclient inside the test NAS VM) logged in as the demo administrator's NAS account -
// standing in for an infected office workstation that has the share mapped - rewrites each document with random bytes, adds a
// ".locked" copy and drops a ransom-note-named file. Only the demo share is touched.
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/attack-nas.mjs
// Detection then happens when the NAS worker scans the share (every 15 minutes) or when the administrator presses "Scan now".
import "./_env.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DEMO_EVIDENCE_DIR } from "./_env.mjs";
import { DOCUMENTS, RANSOM_NOTE_NAME, RANSOM_NOTE, encryptedLike, loadState, saveState, stamp, smbPut } from "./_common.mjs";
import { winPathToWslPath } from "../../../src/lib/nas/agent.js";

const state = loadState();
if (!state.shareName || !state.nasPassword) { console.error("Seed the demo first (reset.mjs)."); process.exit(1); }
const out = [];
const say = (line) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${line}`; out.push(l); console.log(l); };
async function put(remote, buffer) {
  const r = await smbPut({ shareName: state.shareName, user: state.nasUnixUser, password: state.nasPassword, remote, buffer, wslPath: winPathToWslPath });
  say(`SMB PUT ${remote}  ->  ${r.status}`); return r.ok;
}

say(`SIMULATION (synthetic, no malware) - SMB share \\\\office-nas\\${state.shareName} - account ${state.nasUnixUser}`);
let changed = 0;
for (const [key] of DOCUMENTS) {
  if (await put(key, encryptedLike())) changed++;
  await put(`${key}.locked`, encryptedLike(1024));
}
await put(RANSOM_NOTE_NAME, RANSOM_NOTE);
say(`RESULT  ${changed} of ${DOCUMENTS.length} documents rewritten with encryption-like content; ransom-note style file dropped`);
const file = path.join(DEMO_EVIDENCE_DIR, `attack-nas-${stamp().replace(/[:.]/g, "-")}.log`);
writeFileSync(file, out.join("\n") + "\n");
saveState({ lastNasAttack: { at: stamp(), changed, log: file } });
console.log("Saved:", file);
process.exit(0);
