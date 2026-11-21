"""Builds the six Enterprise Resilience Demonstration documents (SOW section 12) as PDFs.

    python scripts/demo/resilience/build_docs.py <runDir> <outDir> <buildCommit>

Every measured number (hashes, counts, times, safety checks, verification results) is read from the evidence of the recorded
run, so the documents cannot drift from what actually happened. Product facts were verified against the code on 21 Nov 2026.
"""
import json, os, re, sys, glob
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether, Image
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon

RUN, OUT, BUILD = sys.argv[1], sys.argv[2], sys.argv[3]
EVID = os.path.join(os.path.expanduser("~"), "Downloads", "Inaya-Resilience-Demo", "evidence")
os.makedirs(OUT, exist_ok=True)
state = json.load(open(os.path.join(EVID, "demo-state.json"), encoding="utf-8"))
base = json.load(open(state["baselineFile"], encoding="utf-8"))
newest = lambda pat: sorted(glob.glob(os.path.join(EVID, pat)))[-1] if glob.glob(os.path.join(EVID, pat)) else None
safety = json.load(open(newest("safety-checklist-*.json"), encoding="utf-8"))
verif = json.load(open(newest("verification-after-*.json"), encoding="utf-8"))
attack = open(os.path.join(RUN, "attack-cloud.log"), encoding="utf-8").read().splitlines()
nas_attack = open(os.path.join(RUN, "attack-nas.log"), encoding="utf-8").read().splitlines()
timeline = open(os.path.join(RUN, "timeline.log"), encoding="utf-8").read().splitlines()
changed = sum(1 for l in attack if "encryption-like rewrite)  ->  200" in l)
refused = sum(1 for l in attack if "REFUSED" in l)
read_ok = any(l.startswith("[") and "READ" in l and "200 OK" in l for l in attack)
delete_refused = any("DELETE" in l and "REFUSED" in l for l in attack)
first = next(l for l in attack if "WRITE" in l)[1:9]; paused = next((l for l in attack if "REFUSED" in l), "[--:--:--]")[1:9]
run_date = base["recordedAt"][:10]

TEAL = colors.HexColor("#0f6e6e"); INK = colors.HexColor("#14202b"); MUTED = colors.HexColor("#5b6878"); GOLD = colors.HexColor("#b8862f"); LINE = colors.HexColor("#d9dee5"); SOFT = colors.HexColor("#e8f2f2"); RED = colors.HexColor("#b42318"); GREEN = colors.HexColor("#1b7f4b")
ss = getSampleStyleSheet()
TITLE = ParagraphStyle("T", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=22, leading=27, textColor=TEAL, spaceAfter=3)
H1 = ParagraphStyle("H1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=14, textColor=TEAL, spaceBefore=9, spaceAfter=4)
H2 = ParagraphStyle("H2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=11, textColor=INK, spaceBefore=6, spaceAfter=3)
B = ParagraphStyle("B", parent=ss["BodyText"], fontName="Helvetica", fontSize=9.4, leading=13, textColor=INK, spaceAfter=4)
SM = ParagraphStyle("SM", parent=B, fontSize=8.3, leading=11, textColor=MUTED)
MONO = ParagraphStyle("M", parent=B, fontName="Courier", fontSize=7.8, leading=10)
LEAD = ParagraphStyle("L", parent=B, fontSize=10.5, leading=15, borderColor=GOLD, borderWidth=0.6, borderPadding=8, backColor=colors.HexColor("#fbf5ea"), spaceBefore=4, spaceAfter=10)
CELL = ParagraphStyle("C", parent=B, fontSize=8.5, leading=11.3, spaceAfter=0); CELLB = ParagraphStyle("CB", parent=CELL, fontName="Helvetica-Bold")
P = lambda t, s=B: Paragraph(t, s)
W = A4[0] - 36 * mm
def bl(items, s=B): return [P("•&nbsp;&nbsp;" + t, s) for t in items]
def nl(items): return [P(f"{i + 1}.&nbsp;&nbsp;{t}") for i, t in enumerate(items)]
def table(rows, widths, head=True):
    t = Table([[P(str(c), CELLB if head and r == 0 else CELL) for c in row] for r, row in enumerate(rows)], colWidths=widths, repeatRows=1 if head else 0)
    st = [("GRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5)]
    if head: st.append(("BACKGROUND", (0, 0), (-1, 0), SOFT))
    t.setStyle(TableStyle(st)); return t
ok = lambda t: f'<font color="#1b7f4b"><b>{t}</b></font>'
no = lambda t: f'<font color="#b42318"><b>{t}</b></font>'
def doc(name, title, story, sub):
    path = os.path.join(OUT, name)
    def footer(c, d):
        c.saveState(); c.setFont("Helvetica", 7.3); c.setFillColor(MUTED)
        c.drawString(18 * mm, 10 * mm, f"Inaya Network · Enterprise Resilience Demonstration · {title}"); c.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Page {d.page}"); c.restoreState()
    d = SimpleDocTemplate(path, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=15 * mm, bottomMargin=16 * mm, title=title, author="Inaya Network")
    d.build([P(title, TITLE), P(sub, SM), Spacer(1, 8)] + story, onFirstPage=footer, onLaterPages=footer); print("wrote", path)

def flow():
    d = Drawing(W, 92); steps = [("Detection", "activity scored per credential, rolling 10 min"), ("Evidence", "rules, counts, confidence; admins notified"), ("Containment", "configured severe level: writes and deletes paused"), ("Recovery", "clean versions or a clean NAS snapshot"), ("Verification", "SHA-256 of restored files vs. baseline")]
    bw = (W - 4 * 14) / 5
    for i, (h, s) in enumerate(steps):
        x = i * (bw + 14); d.add(Rect(x, 14, bw, 66, fillColor=SOFT if i % 2 == 0 else colors.white, strokeColor=TEAL, strokeWidth=1, rx=6, ry=6))
        d.add(String(x + bw / 2, 60, h, fontName="Helvetica-Bold", fontSize=10, fillColor=TEAL, textAnchor="middle"))
        words = s.split(); lines, cur = [], ""
        for w in words:
            if len(cur) + len(w) > 20: lines.append(cur.strip()); cur = ""
            cur += w + " "
        lines.append(cur.strip())
        for k, ln in enumerate(lines[:3]): d.add(String(x + bw / 2, 44 - k * 10, ln, fontName="Helvetica", fontSize=7.3, fillColor=INK, textAnchor="middle"))
        if i < 4: ax = x + bw + 2; d.add(Line(ax, 47, ax + 10, 47, strokeColor=GOLD, strokeWidth=1.5)); d.add(Polygon([ax + 10, 50, ax + 13, 47, ax + 10, 44], fillColor=GOLD, strokeColor=GOLD))
    return d

FACTS_CLOUD = [
    ["Encryption", "Documents uploaded in the workspace are encrypted on the user's device before upload. Files reached through the S3/Azure-compatible API or a NAS are encrypted by Inaya's servers (AES-256-GCM, stored as encrypted 16 MiB pieces), which is what makes server-side versions, backups and rollback possible."],
    ["Version history", "Every bucket keeps earlier versions; a default lifecycle rule removes old versions after 30 days. On for new buckets and applied to existing buckets in Nov 2026 (a company's own setting is kept)."],
    ["Decoy (tripwire) file", "One hidden decoy file in every bucket, placed automatically. Rewriting it is CRITICAL on its own; deleting it alone is HIGH (alert only), because mirror-sync tools delete files missing from their source."],
    ["Detection signals", "Per credential, rolling 10-minute window: mass overwrites (25), mass deletes (25), encryption-like rewrites (5; content entropy at least 7.5 bits/byte and up by at least 1.0), known ransomware extensions (5), ransom-note file names (1), burst downloads (150), burst sharing (12), decoy activity. Score: 25 MEDIUM, 50 HIGH, 80 CRITICAL."],
    ["Evidence and alerts", "Each signal records its rules, counts, score and confidence; owners and admins are notified; an incident can be exported as JSON. A signal is evidence of suspicious activity, not proof of an infection."],
    ["Containment", "Default: at CRITICAL the credential's writes AND deletes are refused for 60 minutes (configurable 5-1440 minutes; level never / high / critical). Reading continues. It always expires and an admin can lift it early."],
    ["Rollback", "Security > Ransomware Signals > Plan rollback lists every file the credential changed, offers the newest version from before each change, marks files the credential created as having nothing earlier, and restores selected files; the attacker's versions stay as older versions."],
]
FACTS_NAS = [
    ["Snapshots", "Daily scheduled snapshot, the last 14 kept, each locked (immutable) for 7 days. Locking is governance-grade: the API refuses deletion, an owner/admin override needs a written reason and is recorded, and root on the appliance itself can still lift it."],
    ["Threat detection", "The NAS worker scans each share every 15 minutes against a clean baseline: files changed, deleted and added, encryption-like rewrites, ransomware extensions and ransom notes, repeated failed logons, snapshot-deletion attempts."],
    ["Response", "On detection: an immutable protective snapshot (kept 30 days) and an alert. Share lockdown (read-only, sessions closed) is a recommendation a person approves, unless the company enables automatic lockdown (CRITICAL only); it always expires."],
    ["Restore", "Side by side into .restored/<snapshot>/ so live files are never overwritten by surprise; in-place restore needs a written reason."],
    ["Off-site copy", "Nightly encrypted backup of each share to Inaya cloud storage; unchanged files are not uploaded again; a sample of each run is read back and compared. Recovery points are currently kept without automatic pruning (the 14-point setting is recorded but not yet enforced)."],
    ["Worker", "Snapshots, scans and off-site copies run in a worker on the customer's own network next to the appliance; if it is switched off they pause."],
    ["Database backup", "The workspace database is backed up nightly, encrypted, 14 kept. This is separate from file versions and NAS snapshots."],
]
LIMITS = [
    "<b>Finite retention.</b> Cloud versions 30 days; NAS snapshots 14 daily (each locked 7 days). Recovery depends on finding an attack inside these windows.",
    "<b>Rule-based detection.</b> A slow, quiet attack can stay below the thresholds; a legitimate bulk job can raise an alert.",
    "<b>No exfiltration prevention.</b> Download bursts raise an alert; reading is never blocked by containment.",
    "<b>Two encryption models.</b> On-device encryption applies to Documents; S3/Azure API and NAS files are encrypted server-side.",
    "<b>Endpoints not covered.</b> Users' own computers still need endpoint security.",
    "<b>NAS depends on the customer network.</b> The worker must run next to the appliance; NAS lockdown needs a person unless automatic lockdown is enabled.",
    "<b>Governance-grade immutability.</b> NAS locks resist the API and stolen credentials, not root on the appliance itself.",
    "<b>No guarantees.</b> No claim of complete prevention, zero data loss or guaranteed recovery.",
]
CLAIMS_OK = ["Ransomware-resilient; tested recovery", "Detects ransomware-like file activity (rule-based) and records the evidence", "Pauses the responsible credential's writes and deletes at the configured severe level; reading continues", "Restores clean versions (30-day cloud version history) and clean NAS snapshots (14 daily, each locked 7 days)", "Integrity verification: restored files compared by SHA-256 with the pre-attack hash", "Documents are encrypted on the user's device before upload", "Nightly encrypted off-site copy of NAS shares in Inaya cloud storage", "Decoy file placed automatically in every bucket"]
CLAIMS_NO = ["Prevents all / every ransomware attack; bulletproof; ransomware-proof; immune", "Guaranteed recovery; zero data loss", "Stops data theft or exfiltration; blocks reading", "AI-powered detection (it is rule-based)", "Real-time NAS detection (scans run every 15 minutes)", "Detects within N seconds / recovers within N minutes (not measured beyond this test)", "Immutable even to the appliance's root user", "Every file is encrypted on your device", "Certified / compliant with a standard (not part of this work)", "The 60-minute pause applies to every alert"]

# 1 Runbook ---------------------------------------------------------------------------------------------------------------
S = [P("Purpose", H1), P("A controlled, repeatable demonstration of detection, evidence, containment, recovery and integrity verification in Inaya Business Workspace, using a synthetic company in an isolated environment. It is not a penetration test and uses no malware.")]
S += [P("Environment (Workstream A)", H1), table([["Item", "Setting"],
    ["Product build", f"Inaya Business Workspace, commit {BUILD}, production build served locally"],
    ["Database", base["environment"]["database"]], ["File storage", "local folder on the demo computer only; Filebase and Pinata credentials replaced by placeholders"],
    ["E-mail", "Resend keys replaced by a placeholder: any send fails authentication, nothing is delivered"],
    ["NAS", base["environment"]["nasAppliance"]], ["Company", f"{base['company']['name']} (synthetic), people on the reserved .example domain"],
    ["Compromised account", f"{base['company']['compromisedAccount']['label']} (an S3 sync credential of the member {base['company']['compromisedAccount']['member']})"],
    ["Layouts shown", "Standard workspace and ERP mode (the whole response is run from ERP mode's Admin menu)"]], [W * 0.25, W * 0.75])]
S += [P("Environment safety checklist (run before every rehearsal and demonstration)", H2), table([["Check", "Result"]] + [[c["name"], ok("PASS") if c["result"] == "PASS" else no("FAIL")] for c in safety["checks"]], [W * 0.78, W * 0.22]), P(f"Last run {safety['checkedAt'][:16].replace('T', ' ')} UTC. Command: node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/safety-check.mjs", SM)]
S += [P("Baseline evidence (recorded before the attack)", H2), P(f"Recorded {base['recordedAt'][:19].replace('T', ' ')} UTC. NAS snapshot <b>{base['nas']['snapshot']['name']}</b> (id {base['nas']['snapshot']['id']}), created {str(base['nas']['snapshot']['createdAt'])[:19]}, immutable until {str(base['nas']['snapshot']['retentionUntil'])[:19]}, {base['nas']['snapshot']['lockMode']} mode. Off-site recovery point {base['nas']['offsiteRecoveryPoint']}. Bucket versioning: {base['cloud']['versioning']}; decoy file present: {'yes' if base['cloud']['tripwire'] else 'no'}.")]
S += [table([["Document", "SHA-256 (first 24)", "Bytes", "Cloud version id"]] + [[f["key"], f["sha256"][:24] + "…", f["sizeBytes"], str(f["versionId"])[:12]] for f in base["cloud"]["files"]], [W * 0.42, W * 0.3, W * 0.09, W * 0.19])]
S += [P("Detection settings in this scenario", H2), P("Cloud: policy on, automatic pause at CRITICAL for 60 minutes; thresholds as in the technical factsheet (rolling 10-minute window). NAS: threat policy on, protective snapshot on, automatic lockdown OFF (a person approves), lockdown 60 minutes, scans every 15 minutes (pressed manually in the demonstration).")]
S += [PageBreak(), P("Demonstration sequence (Workstream B)", H1), table([["Stage", "What happens", "How"],
    ["1 Normal operation", "Standard workspace, then ERP mode; the bucket with its documents, versioning and decoy; NAS snapshots", "Browser"],
    ["2 Simulation", "A ransom-note-named file, then encryption-like rewrites with .locked copies, using the compromised sync credential", "attack-cloud.mjs"],
    ["3 Detection and evidence", "Notification; Ransomware Signals: level, score, confidence, rules and counts", "ERP > Admin > Security > Ransomware Signals"],
    ["4 Containment", "'Writes paused' for the credential; further writes and deletes refused; reading works", "same page + console"],
    ["5 Cloud recovery", "Plan rollback > Restore selected; version history shows the clean version current again", "same page; S3-Compatible Storage"],
    ["6 NAS", "SMB simulation; Scan now; protective snapshot; Approve lockdown; Restore copy of nightly-clean; off-site recovery points", "attack-nas.mjs; Sovereign NAS > Security, Snapshots, Backup"],
    ["7 Integrity", "SHA-256 of every restored file vs. the baseline", "verify.mjs"],
    ["8 Back to normal", "Lift the pause and the lockdown", "Ransomware Signals; Sovereign NAS > Security"]], [W * 0.18, W * 0.55, W * 0.27])]
S += [P("Commands (from the inaya-network-dapp folder)", H2)] + [P(c, MONO) for c in [
    "NEXT_DIST_DIR=.next-prod npx next build                      # after code changes",
    "node --env-file=.env.local scripts/demo/resilience/start-server.mjs        # demo server + NAS worker, http://127.0.0.1:3003",
    "node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/safety-check.mjs",
    "node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/attack-cloud.mjs [--scenario decoy]",
    "node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/attack-nas.mjs",
    "node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/verify.mjs --stage after",
    "node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/reset.mjs      # clean + reseed"]]
S += [P("Reset procedure (tested)", H2)] + nl(["Stop presenting; lift any open pause and lockdown (or let reset do it).", "Run reset.mjs. It removes only the demo company: its rows in every test-database collection (refuses on any other database), its NAS snapshots (locked ones through the governance override with a recorded reason), share, NAS account and the local storage folder, then seeds a fresh company and records new baseline evidence.", "Run safety-check.mjs: every line must say PASS.", "Sign in again with a fresh session (the reset issues a new one in the demo state file, which never leaves the computer)."])
S += [P("If a step fails", H2), P("Stop, record what happened and why, reset, and repeat only once the cause is understood. Never edit a failed step into an apparent success. (This rule found three real defects during rehearsal: see the validation record.)")]
doc("1-Demonstration-Runbook.pdf", "Demonstration runbook", S, f"Runbook, environment checklist, baseline evidence and reset procedure · run of {run_date}")

# 2 Presenter guide -------------------------------------------------------------------------------------------------------
S = [P("Live session, 20-30 minutes plus questions. Everything runs on the presenter's computer against the isolated demo environment; nothing touches production. Open in ERP mode unless the audience uses the standard layout.", LEAD)]
S += [P("Before the session (15 minutes)", H1)] + nl(["Start the NAS VM, then start-server.mjs; wait for 'Ready'.", "Run reset.mjs (fresh company and baseline), then safety-check.mjs: all PASS.", "Sign the demo browser in (fresh session); close other tabs, notifications and anything personal.", "Open two windows: the browser (ERP mode, Admin) and a terminal in the inaya-network-dapp folder.", "Have the factsheet and FAQ open for questions."])
S += [P("Running order", H1), table([["Min", "Segment", "Say / do"],
    ["0-3", "Context", "Business continuity: what happens when ransomware reaches the files? Everything is the real product, synthetic data, isolated environment."],
    ["3-6", "Overview", "Standard workspace, switch to ERP mode; the bucket's documents, version history and the decoy; the NAS snapshot list and schedule."],
    ["6-9", "Simulation", "Run attack-cloud.mjs and read the console: ransom-note name, encryption-like rewrites, then 403 REFUSED. Stress: synthetic, no malware."],
    ["9-13", "Detection and evidence", "Bell notification; Ransomware Signals: level, score, confidence, rules and counts. A signal is evidence, not proof."],
    ["13-15", "Containment", "'Writes paused' card; console shows refused writes and deletes and a working read. It is the configured severe-level response, not every alert; Lift is available."],
    ["15-19", "Cloud recovery", "Plan rollback: changed files have a clean version, created files have nothing earlier. Restore selected. Show the version history."],
    ["19-24", "NAS", "Run attack-nas.mjs; Sovereign NAS > Security > Scan now; protective snapshot; Approve lockdown; Snapshots > nightly-clean > Restore copy; Backup: off-site recovery points."],
    ["24-26", "Integrity", "Run verify.mjs: restored copies MATCH the baseline hashes; NAS live files still show DIFFERENT until moved back. Explain, don't hide."],
    ["26-28", "Boundaries", "Retention windows, rule-based detection, no exfiltration blocking, endpoint and NAS-worker responsibilities."],
    ["28-30", "Next steps", "Questions; offer the factsheet and a follow-up session with their IT team."]], [W * 0.1, W * 0.2, W * 0.7])]
S += [P("Optional scenario B: the decoy", H2), P("attack-cloud.mjs --scenario decoy uses a second credential whose first action rewrites the bucket's decoy file: CRITICAL on its own, the credential is paused at once. Use it when the audience asks what happens if an attack starts with files nobody uses.")]
S += [P("Presenter notes", H1)] + bl([
    "Use precise terms: ransomware-resilient, tested recovery, write/delete containment, integrity verification.",
    "The pause is per credential. Another account of the same company keeps working.",
    "Waiting: in this environment each request takes a few seconds, so the cloud simulation takes about a minute; do not quote it as a detection time.",
    "If the version panel shows 'Health: Degraded (replicas 1/2)': the demo stores everything in one local folder instead of two cloud providers. Production keeps two replicas.",
    "If something fails: say so, reset, repeat. Never improvise a result."])
S += [PageBreak(), P("Technical Q&amp;A guide", H1)]
for q, a in [
    ("How is a 'credential' identified?", "Each S3/Azure access key, or a signed-in person, is an actor; activity is scored per actor."),
    ("Why not block reads too?", "Blocking reads would stop legitimate work and recovery; containment targets destructive operations. Exfiltration is alerted (download bursts), not prevented."),
    ("What are the thresholds?", "Rolling 10 minutes: 25 overwrites, 25 deletes, 5 encryption-like rewrites, 5 ransomware extensions, 1 ransom-note name, 150 downloads, 12 shares; decoy rewrite is critical alone. A company can tune them."),
    ("How is 'encryption-like' measured?", "Shannon entropy of the first 32 KB of the new content: at least 7.5 bits/byte and at least 1.0 higher than the version it replaced, so already-compressed files do not count."),
    ("Can an attacker delete the history?", "Cloud: deleting creates a hidden marker; earlier versions stay until the 30-day rule. NAS: snapshots are locked for 7 days against the API; an owner override needs a recorded reason; root on the appliance can still lift it."),
    ("Is the NAS data copied off site?", "Yes, nightly to Inaya cloud storage, encrypted, with a sample read back. Recovery points are currently kept without automatic pruning."),
    ("Who performs recovery?", "The company's own Owner/Admin. Inaya support can guide; Inaya staff do not restore company files."),
    ("Does this replace backup and endpoint security?", "No. It adds recovery points and detection to the files stored in Inaya; endpoints and other systems still need their own controls."),
    ("What is logged?", "Signals, containments, lifts, rollbacks, NAS events, lockdowns and restores are recorded in the activity and NAS evidence trails; an incident export is available."),
    ("Is it certified?", "No compliance certification is claimed for this capability.")]:
    S += [P(f"<b>{q}</b>"), P(a)]
doc("2-Live-Demo-Presenter-Guide.pdf", "Live demonstration presenter guide", S, "Script, presenter notes, checklist, reset and technical Q&A")

# 3 One-pager ------------------------------------------------------------------------------------------------------------
S = [P("When ransomware reaches business files, the question is not only whether it is noticed, but whether the business can carry on. Inaya Business Workspace combines day-to-day operations (standard workspace or ERP mode) with built-in data protection, so a company can <b>restore its data instead of paying</b>.", LEAD), flow(), Spacer(1, 6)]
S += [table([["", "Cloud files", "Office NAS"],
    ["Protect", "Documents encrypted on the user's device; all files stored as encrypted pieces", "Encrypted off-site copy every night"],
    ["Preserve", "30 days of earlier versions; hidden decoy file in every bucket", "Daily snapshot, last 14 kept, each locked 7 days"],
    ["Detect", "Ransomware-like activity scored per account, evidence recorded, admins notified", "Share scanned every 15 minutes against a clean baseline"],
    ["Contain", "At the configured severe level the account's writes and deletes pause for 60 min; reading continues", "Protective locked snapshot; read-only lockdown with approval"],
    ["Recover", "Roll changed files back to clean versions", "Restore a clean snapshot side by side"]], [W * 0.13, W * 0.47, W * 0.4])]
S += [P("Tested, not just described", H1), P(f"In a controlled test on {run_date} with a synthetic company, a simulated attack changed {changed} files before the account was paused automatically; {refused} further writes and deletes were refused while reading continued. Every restored file matched its pre-attack SHA-256 hash.")]
S += [P("Boundaries", H2), P("Detection is rule-based and does not stop data being read or copied. Recovery depends on clean copies within the retention windows. NAS protection runs on the customer's network; endpoints still need their own security.", SM)]
S += [P("<b>Request an Enterprise Resilience Demonstration</b>: see it live, in an isolated environment.", LEAD)]
doc("3-Enterprise-Resilience-Overview.pdf", "Enterprise Resilience overview", S, "Inaya Business Workspace · one page")

# 4 Factsheet ------------------------------------------------------------------------------------------------------------
S = [P("Cloud file protection (S3/Azure-compatible storage and Documents)", H1), table([["Capability", "How it works"]] + FACTS_CLOUD, [W * 0.22, W * 0.78])]
S += [P("NAS protection (customer-network appliance)", H1), table([["Capability", "How it works"]] + FACTS_NAS, [W * 0.22, W * 0.78])]
S += [P("Boundaries and customer responsibilities", H1)] + bl(LIMITS)
doc("4-Technical-Factsheet.pdf", "Technical factsheet", S, "Cloud and NAS protection described separately · verified against the product on 21 Nov 2026")

# 5 Sales pack -----------------------------------------------------------------------------------------------------------
S = [P("The response workflow", H1), flow(), P("Detection and evidence apply to cloud files per credential and to NAS shares per scan; containment differs (credential pause vs. share lockdown); recovery and verification apply to both.", SM)]
S += [P("Demonstration sequence and talking points", H1)] + bl([
    "<b>Open with continuity, not fear:</b> 'what happens when ransomware reaches your files?'",
    "<b>Show it working:</b> real product, synthetic company, isolated environment.",
    f"<b>Proof points from the test:</b> {changed} files changed before the automatic pause; {refused} writes/deletes refused; reading continued; every restored file matched its original hash.",
    "<b>Cloud and NAS are different:</b> credential pause and version rollback in the cloud; snapshots, approved lockdown and side-by-side restore on the NAS.",
    "<b>Boundaries build trust:</b> state the retention windows and what it does not do."])
S += [P("Validated claims (approved wording)", H1)] + bl([ok("USE") + "&nbsp; " + c for c in CLAIMS_OK])
S += [P("Prohibited or unsupported claims", H1)] + bl([no("DO NOT SAY") + "&nbsp; " + c for c in CLAIMS_NO])
S += [PageBreak(), P("Prospect FAQ", H1)]
for q, a in [
    ("Does Inaya stop ransomware?", "It detects ransomware-like activity, pauses the responsible account's writes and deletes at the configured severe level, and helps restore clean copies. It does not prevent every attack."),
    ("Will we lose data?", "Changes made before the pause can be rolled back to versions from before the attack, within the 30-day cloud and 14-snapshot NAS windows. No product can guarantee zero data loss."),
    ("Does it stop data theft?", "No. Unusual download activity raises an alert, but reading is not blocked."),
    ("How quickly does it react?", "Cloud activity is evaluated as it happens; NAS shares are scanned every 15 minutes. Times depend on the attack and the environment; we do not promise a detection time."),
    ("Can we use it without a NAS?", "Yes. Cloud protection works on its own; NAS protection is for companies running the Inaya NAS worker on their network."),
    ("Who restores the files?", "Your Owner or Admin, from the product. Inaya support can guide."),
    ("Is anything to set up?", "Version history, decoy files, detection and NAS snapshot and off-site schedules are on by default; settings can be adjusted."),
    ("Do we still need antivirus and backups?", "Yes. Endpoint security and your wider backup strategy remain your responsibility.")]:
    S += [P(f"<b>{q}</b>"), P(a)]
S += [P("Follow-up email template", H1), P("<b>Subject:</b> Your Inaya Enterprise Resilience Demonstration: summary and next steps"), P(
    "Hi {first name},<br/><br/>Thank you for joining today's Enterprise Resilience Demonstration. As a recap, you saw a controlled, synthetic attack against a test company in an isolated environment, and how Inaya Business Workspace:<br/>"
    "• detected the ransomware-like activity and recorded the evidence;<br/>• paused the responsible account's writes and deletes at the configured severe level, while reading continued;<br/>"
    "• restored clean file versions and a clean NAS snapshot; and<br/>• verified the restored files against their original SHA-256 hashes.<br/><br/>"
    "We also covered the boundaries: rule-based detection, the 30-day and 14-snapshot recovery windows, and that endpoint security remains essential.<br/><br/>"
    "Attached are the one-page overview and the technical factsheet. If useful, we can run a session with your IT team on {proposed date}, or answer questions in writing.<br/><br/>Kind regards,<br/>{name}<br/>Inaya Network", B)]
doc("5-Sales-Enablement-Pack.pdf", "Sales enablement pack", S, "Flow, talking points, validated and prohibited claims, FAQ and follow-up template")

# 6 Validation record ----------------------------------------------------------------------------------------------------
cloud_rows = [r for r in verif["rows"] if r["where"].startswith("cloud")]; nas_restored = [r for r in verif["rows"] if ".restored/" in r["where"]]; nas_live = [r for r in verif["rows"] if r["where"].endswith("(live)")]
S = [table([["Item", "Record"], ["Build", f"commit {BUILD}, production build"], ["Configuration", "Isolated demo environment (see runbook); cloud pause at CRITICAL for 60 min; NAS automatic lockdown off"], ["Test date", f"{run_date} (UTC)"], ["Operator", "Claude Code, automated test operator, for the product owner"], ["Evidence", f"Downloads/Inaya-Resilience-Demo/evidence and runs/{os.path.basename(RUN)}"]], [W * 0.22, W * 0.78])]
S += [P("Demonstrated behaviours", H1), table([["Behaviour", "Result", "Evidence"],
    ["Isolated environment", ok("PASS") + f" ({sum(c['result'] == 'PASS' for c in safety['checks'])}/{len(safety['checks'])} checks)", os.path.basename(newest("safety-checklist-*.json"))],
    ["Baseline recorded", ok("PASS"), os.path.basename(state["baselineFile"])],
    ["Simulation reproducible", ok("PASS"), "attack-cloud.log, attack-nas.log (second clean run after the fixes)"],
    ["Detection and evidence", ok("PASS"), "09-signal-evidence.png, 07-notifications.png"],
    ["Containment (writes and deletes refused, reads continue)", ok("PASS") if refused and read_ok and delete_refused else no("CHECK"), f"first write {first}, first refusal {paused}; {changed} changed, {refused} refused"],
    ["Cloud rollback", ok("PASS"), "10-rollback-plan.png, 11-rollback-done.png, 12-file-versions-after.png"],
    ["NAS detection, protective snapshot, approved lockdown", ok("PASS"), "14-nas-threat-event.png, 15-nas-lockdown.png"],
    ["NAS side-by-side restore; off-site copy", ok("PASS"), "17-nas-restore-copy.png, 18-nas-offsite.png"],
    ["Integrity: cloud documents match baseline", ok(f"{sum(r['match'] for r in cloud_rows)}/{len(cloud_rows)} MATCH"), os.path.basename(newest("verification-after-*.json"))],
    ["Integrity: NAS restored copies match baseline", ok(f"{sum(r['match'] for r in nas_restored)}/{len(nas_restored)} MATCH"), "same file"],
    ["NAS live files (not moved back)", f"{sum(not r['match'] for r in nas_live)}/{len(nas_live)} differ, as expected", "restore is side by side by design"]], [W * 0.38, W * 0.22, W * 0.4])]
S += [P("Deviations and defects found (documented, not hidden)", H1), table([["#", "Finding", "Resolution"],
    ["1", "Product defect (also in production): a paused credential could still DELETE through the S3 and Azure APIs; multi-delete, folder delete and multipart completion also skipped the pause.", "Fixed: the routes pass the caller; containment checked for all; test/ransomware-containment-deletes.test.mjs. Rehearsal stopped, reset and repeated."],
    ["2", "Product defect (also in production): Plan rollback offered the attacker's own version as the 'clean' version, so restoring brought back the encrypted file.", "Fixed: the version created by the change is the cutoff and never offered; created files show nothing to restore. Real-store test proves original bytes come back; it fails on the old code."],
    ["3", "Display defect: the NAS snapshot schedule form showed 'keep last 7' beside an active policy of 14.", "Fixed: the form shows the saved schedule."],
    ["4", "Product gap: off-site NAS recovery points record 'keep 14' but are not pruned.", "Documented as-is in all materials; not changed (outside this SOW). Decision for the product owner."],
    ["5", "Environment: one local storage folder instead of two cloud providers, so version panels show 'Health: Degraded (replicas 1/2)'.", "Expected in isolation; explained in the runbook; the video zooms on the version list."],
    ["6", "Environment: NAS scan pressed manually ('Scan now') instead of waiting for the 15-minute schedule; lockdown approved by the presenter.", "Stated in narration and runbook."],
    ["7", "Rehearsal 1: the seed wrote NAS files as root, so the simulation could not create .locked files.", "Seed now saves files over SMB as the staff account; not presented as a protection."],
    ["8", "Video: waiting periods shortened; every frame is a real screenshot or the real console output.", "Labelled 'Edited walkthrough' on every frame."]], [W * 0.05, W * 0.53, W * 0.42])]
S += [P("Sign-off (SOW section 15)", H1), table([["Approver", "Name", "Approval / date"], ["Product owner", "", ""], ["Engineering lead", "", ""], ["QA / test operator", "", ""], ["Marketing / content", "", ""]], [W * 0.35, W * 0.35, W * 0.3])]
doc("6-Validation-Record.pdf", "Final validation record", S, f"Build, configuration, test date, demonstrated behaviours and deviations · {run_date}")

# 7 Co-founder summary ---------------------------------------------------------------------------------------------------
S = [P("In short", H1), P(f"We now have a real, repeatable proof that Inaya Business Workspace handles a ransomware-style attack: it notices it, stops the account doing the damage, brings the files back and proves they are the originals. It runs on a fake company ('Northwind Advisory (Demo)') in a separate test environment, so it can never touch customers. On {run_date}, the simulated attack changed {changed} files before the account was paused automatically; {refused} further writes and deletes were refused while reading kept working; every restored file matched its original fingerprint (SHA-256).", LEAD)]
S += [P("What is in the folder 'Inaya Ransomware Demo'", H1), table([["File", "What it is for"],
    ["Inaya-Enterprise-Resilience-Demo.mp4", "Main video, about 5 minutes, captions built in: website, sales outreach, investor follow-ups"],
    ["Inaya-Enterprise-Resilience-Demo-Short.mp4", "About 1 minute cut for social media and quick intros"],
    [".srt files and thumbnail", "Captions for platforms that want them separately; cover image for YouTube/LinkedIn"],
    ["1 Demonstration runbook", "How the test environment is built, checked and reset; the before-attack evidence"],
    ["2 Live demo presenter guide", "A 20-30 minute live demo script with notes and answers to technical questions"],
    ["3 Enterprise Resilience overview", "One page to send to prospects"],
    ["4 Technical factsheet", "For IT and security teams: how cloud and NAS protection work, and their limits"],
    ["5 Sales enablement pack", "What we may and may not claim, talking points, FAQ, follow-up email"],
    ["6 Validation record", "What was tested, the results, every problem found; the sign-off table is for us to complete"]], [W * 0.38, W * 0.62])]
S += [P("How the demonstration goes", H1)] + nl([
    "The company works normally: the standard workspace and ERP mode, files in cloud storage with version history and a hidden decoy file, and an office NAS with locked daily snapshots.",
    "A test script plays a laptop hit by ransomware: it drops a 'ransom note' file and scrambles business files, using that laptop's real sync key. No real malware is involved.",
    "Inaya scores the activity, alerts the admins and, at the critical level, pauses that key: writes and deletes are refused, reading still works.",
    "The admin rolls the files back to their clean versions in a few clicks; on the NAS, a person approves a read-only lockdown and restores the clean snapshot beside the live files.",
    "A check recomputes each restored file's fingerprint and compares it with the one recorded before the attack: they match."])
S += [P("Problems the rehearsal found (and fixed)", H1), P("The SOW said: if a step fails, stop and find out why. That rule found three real problems, two of which were also live in production:"), table([["Problem", "Why it mattered", "Status"],
    ["A paused account could still DELETE files through the S3/Azure connection", "The pause is meant to stop deletes too; our materials say so", ok("Fixed and tested")],
    ["'Roll back' put back the scrambled version instead of the original", "Recovery would not have worked in a real attack", ok("Fixed; a test proves the originals come back")],
    ["A NAS screen showed 'keep 7' while 14 snapshots were really kept", "Confusing on camera", ok("Fixed")]], [W * 0.42, W * 0.36, W * 0.22])]
S += [P("Decisions for us", H1)] + nl([
    "<b>Push the fixes to production.</b> They are committed but not yet live; the two security fixes matter for real customers.",
    "<b>Off-site NAS copies are never cleaned up.</b> The 'keep 14' setting is stored but not enforced, so these copies grow forever (more storage cost, nothing lost). Build the clean-up, or leave as is? The materials currently describe it honestly.",
    "<b>Correct one sentence</b> in the earlier 'Ransomware Protection Overview' PDF ('off-site NAS copies cover the last 14 days'): off-site copies are currently kept longer.",
    "<b>Sign off</b> the validation record (product owner, engineering, QA, marketing) before publishing the video.",
    "<b>Voice:</b> the video uses the computer's built-in voice. A human voice-over can replace it later without re-recording."])
S += [P("What we must not say", H2), P("No 'stops all ransomware', 'bulletproof', 'zero data loss' or 'guaranteed recovery'; it does not stop data being read or copied; detection is rule-based, not AI; NAS checks run every 15 minutes, not instantly.", SM)]
doc("7-Summary-for-Co-founder.pdf", "Summary for the co-founder", S, f"Enterprise Resilience Demonstration · what was built, what it proved, what we need to decide · {run_date}")
