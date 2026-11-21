// scripts/demo/resilience/_common.mjs -- fixed identities and test data for the Enterprise Resilience Demonstration.
// Everything here is synthetic: the company, the people (reserved .example domain, so no mail can be delivered) and the
// documents. Fixed ids make reset deterministic.
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEMO_EVIDENCE_DIR } from "./_env.mjs";

export const DEMO_PORT = Number(process.env.RESILIENCE_DEMO_PORT || 3003);
export const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`;
export const DEMO_ORG_ID = "64656d6f7265736931000001"; // "demoresi1"
export const DEMO_ORG_NAME = "Northwind Advisory (Demo)";
export const ADMIN = { email: "alex.morgan@northwind.example", name: "Alex Morgan", role: "owner" };
export const COMPROMISED = { email: "sam.lee@northwind.example", name: "Sam Lee", role: "member" };
export const BUCKET = "client-files";
export const NAS_SHARE = "finance";
export const NAS_APPLIANCE = "Northwind Office NAS";
export const STATE_FILE = path.join(DEMO_EVIDENCE_DIR, "demo-state.json");

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const lines = (...l) => Buffer.from(l.join("\n") + "\n");
/** The business documents used in the bucket and on the NAS share (synthetic). */
export const DOCUMENTS = [
  ["board/Board-Minutes-Oct-2026.md", lines("# Board minutes - October 2026", "Present: A. Morgan (chair), R. Patel, J. Okafor", "1. Q3 results approved.", "2. Office lease renewal authorised up to GBP 84,000 per year.", "3. Next meeting: 12 January 2027.")],
  ["board/Strategy-2027-Draft.md", lines("# Strategy 2027 (draft)", "- Grow the advisory practice to 40 clients", "- Open a second office in Leeds", "- Hire two senior consultants")],
  ["clients/Harbor-Logistics-Onboarding.md", lines("# Harbor Logistics - onboarding", "Engagement lead: Sam Lee", "Scope: quarterly management accounts and VAT returns", "Kick-off: 3 December 2026")],
  ["clients/Meridian-Health-Engagement-Letter.txt", lines("ENGAGEMENT LETTER", "Client: Meridian Health Group (fictitious)", "Services: annual audit support, payroll review", "Fee: GBP 18,500 + VAT, billed quarterly")],
  ["contracts/2026-Client-Services-Agreement.txt", lines("CLIENT SERVICES AGREEMENT 2026", "Between Northwind Advisory Ltd and the Client.", "Term: 12 months from signature. Notice period: 60 days.", "Liability cap: total fees paid in the preceding 12 months.")],
  ["contracts/NDA-Harbor-Logistics.txt", lines("MUTUAL NON-DISCLOSURE AGREEMENT", "Parties: Northwind Advisory Ltd and Harbor Logistics Ltd (fictitious)", "Duration: 3 years from the effective date.")],
  ["finance/Q3-2026-Management-Accounts.csv", lines("line,amount_gbp", "revenue,412300", "cost_of_sales,151900", "gross_profit,260400", "overheads,188700", "operating_profit,71700")],
  ["finance/Invoice-Register-Nov-2026.csv", lines("invoice,client,amount_gbp,status", "NW-2026-1101,Harbor Logistics,4200,paid", "NW-2026-1102,Meridian Health,6166,sent", "NW-2026-1103,Kestrel Foods,2950,draft")],
  ["hr/Payroll-Calendar-2027.csv", lines("month,cut_off,pay_day", "January,2027-01-20,2027-01-28", "February,2027-02-17,2027-02-25", "March,2027-03-17,2027-03-26")],
  ["hr/Staff-Handbook-v4.md", lines("# Staff handbook v4", "Working hours: 09:00-17:30, flexible start between 08:00 and 10:00.", "Annual leave: 25 days plus bank holidays.", "Security: report suspicious e-mails to it@northwind.example.")],
];

/** Encryption-like content: random bytes (Shannon entropy ~8 bits/byte), as ransomware output looks. Synthetic, not malware. */
export const encryptedLike = (n = 4096) => randomBytes(n);
export const RANSOM_NOTE_NAME = "HOW_TO_RESTORE_YOUR_FILES.txt";
export const RANSOM_NOTE = Buffer.from("DEMONSTRATION ONLY. This is a harmless test file that imitates a ransom note's name. No data was encrypted by malware.\n");

export function loadState() { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}; }
export function saveState(patch) { const s = { ...loadState(), ...patch }; writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); return s; }
export const stamp = () => new Date().toISOString();
export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/** A real SMB client (smbclient inside the test NAS VM) acting as a NAS user: creates the folder if needed, then uploads. */
export async function smbPut({ shareName, user, password, remote, buffer, wslPath }) {
  const run = promisify(execFile);
  const tmp = path.join(os.tmpdir(), `demo-smb-${randomBytes(6).toString("hex")}.bin`); writeFileSync(tmp, buffer);
  const dir = remote.includes("/") ? remote.slice(0, remote.lastIndexOf("/")) : "";
  const smb = (cmd) => run("wsl.exe", ["-d", "Ubuntu", "-u", "root", "--", "smbclient", `//127.0.0.1/${shareName}`, "-U", `${user}%${password}`, "-c", cmd], { timeout: 60000 });
  try {
    if (dir) await smb(`mkdir "${dir}"`).catch(() => {}); // already there is fine
    const { stdout, stderr } = await smb(`put ${wslPath(tmp)} "${remote}"`);
    const status = (stdout + stderr).match(/NT_STATUS_\w+/)?.[0];
    return { ok: !status, status: status || "OK" };
  } catch (e) { return { ok: false, status: ((e.stdout || "") + (e.stderr || "")).match(/NT_STATUS_\w+/)?.[0] || "ERROR" }; }
  finally { try { unlinkSync(tmp); } catch { /* gone */ } }
}
