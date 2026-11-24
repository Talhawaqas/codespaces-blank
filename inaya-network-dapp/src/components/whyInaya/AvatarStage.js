"use client";
// src/components/whyInaya/AvatarStage.js -- the AI avatar explainer "video" (owner change to SOW 5.4/5.5, 24 Nov 2026).
// A canvas stage: an ORIGINAL synthetic presenter (illustrated person or gold orb -- the visitor picks; never a real
// person's face or voice) beside timed scenes built from the same validated script as the transcript.
// Audio: Gemini narration, generated scene by scene (each scene signed by the server), analysed live so the mouth / orb moves with the voice; if that is not
// available, the device's own voice reads the same text. Nothing plays until the visitor presses Play.
// "Download video" records this canvas + the narration in the browser (WebM); nothing is uploaded or stored.
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "../../lib/whyInaya/savings.js";

const W = 960, H = 540, PANEL = 330;
const C = { bg: "#0a0e14", panel: "#111a2b", gold: "#d4a24c", goldDeep: "#b8862f", text: "#e8edf5", muted: "#a7b3c6", line: "rgba(255,255,255,0.10)", good: "#6ee7b7", warn: "#fcd34d" };

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/); const lines = []; let line = "";
  for (const w of words) { const t = line ? `${line} ${w}` : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line); return lines;
}
function drawText(ctx, text, x, y, maxW, lh, maxLines = 99) {
  const lines = wrap(ctx, text, maxW); const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] = shown[maxLines - 1].replace(/\s+\S*$/, "") + "…";
  shown.forEach((l, i) => ctx.fillText(l, x, y + i * lh)); return y + shown.length * lh;
}
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// ---------------------------------------------------------------- avatars
function drawPresenter(ctx, t, amp, blink, still) {
  const cx = PANEL / 2, bob = still ? 0 : Math.sin(t * 1.7) * 2 + amp * 3, tilt = still ? 0 : Math.sin(t * 0.9) * 0.025 + amp * 0.02;
  // shoulders / blazer
  ctx.save(); ctx.translate(cx, 330 + bob * 0.4);
  const breathe = still ? 1 : 1 + Math.sin(t * 1.7) * 0.008;
  ctx.scale(1, breathe);
  ctx.fillStyle = "#1c2a44"; ctx.beginPath(); ctx.moveTo(-125, 210); ctx.quadraticCurveTo(-120, 40, -45, 20); ctx.lineTo(45, 20); ctx.quadraticCurveTo(120, 40, 125, 210); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#eef2f7"; ctx.beginPath(); ctx.moveTo(-34, 22); ctx.lineTo(0, 92); ctx.lineTo(34, 22); ctx.closePath(); ctx.fill(); // shirt
  ctx.fillStyle = "#15213a"; ctx.beginPath(); ctx.moveTo(-45, 20); ctx.lineTo(-8, 110); ctx.lineTo(-30, 120); ctx.lineTo(-70, 40); ctx.closePath(); ctx.fill(); // lapels
  ctx.beginPath(); ctx.moveTo(45, 20); ctx.lineTo(8, 110); ctx.lineTo(30, 120); ctx.lineTo(70, 40); ctx.closePath(); ctx.fill();
  ctx.fillStyle = C.gold; ctx.beginPath(); ctx.arc(-52, 70, 6, 0, Math.PI * 2); ctx.fill(); // Inaya gold pin
  ctx.restore();
  // neck + head
  ctx.save(); ctx.translate(cx, 210 + bob); ctx.rotate(tilt);
  ctx.fillStyle = "#b67b5c"; rrect(ctx, -20, 70, 40, 60, 12); ctx.fill();
  ctx.fillStyle = "#c98f6c"; ctx.beginPath(); ctx.ellipse(0, 10, 72, 88, 0, 0, Math.PI * 2); ctx.fill(); // face
  ctx.fillStyle = "#b67b5c"; ctx.beginPath(); ctx.ellipse(-72, 18, 10, 18, 0, 0, Math.PI * 2); ctx.ellipse(72, 18, 10, 18, 0, 0, Math.PI * 2); ctx.fill(); // ears
  ctx.fillStyle = "#231a16"; ctx.beginPath(); ctx.moveTo(-76, 0); ctx.quadraticCurveTo(-82, -92, 0, -86); ctx.quadraticCurveTo(80, -92, 77, 0); ctx.quadraticCurveTo(70, -48, 20, -52); ctx.quadraticCurveTo(-40, -40, -76, 0); ctx.fill(); // hair
  // eyes
  const eyeH = blink ? 1.2 : 7.5; const look = still ? 0 : Math.sin(t * 0.6) * 1.5;
  for (const ex of [-27, 27]) { ctx.fillStyle = "#fbfbfb"; ctx.beginPath(); ctx.ellipse(ex, 4, 12, eyeH, 0, 0, Math.PI * 2); ctx.fill(); if (!blink) { ctx.fillStyle = "#2b1d14"; ctx.beginPath(); ctx.arc(ex + look, 5, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(ex + look + 1.8, 3, 1.6, 0, Math.PI * 2); ctx.fill(); } }
  // brows lift slightly on louder syllables
  ctx.strokeStyle = "#231a16"; ctx.lineWidth = 4.5; ctx.lineCap = "round"; const lift = amp * 4;
  ctx.beginPath(); ctx.moveTo(-40, -16 - lift); ctx.quadraticCurveTo(-27, -23 - lift, -14, -17 - lift); ctx.moveTo(14, -17 - lift); ctx.quadraticCurveTo(27, -23 - lift, 40, -16 - lift); ctx.stroke();
  ctx.strokeStyle = "#a96f50"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 12); ctx.quadraticCurveTo(-6, 34, 3, 38); ctx.stroke(); // nose
  // mouth: opens with the voice
  const open = Math.min(1, amp * 1.6);
  if (open > 0.06) { ctx.fillStyle = "#5b2320"; ctx.beginPath(); ctx.ellipse(0, 58, 17 + open * 5, 3 + open * 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#f3eee9"; ctx.fillRect(-12, 58 - (3 + open * 13) + 1, 24, Math.min(5, 2 + open * 4)); }
  else { ctx.strokeStyle = "#7c2f2a"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-18, 55); ctx.quadraticCurveTo(0, 66, 18, 55); ctx.stroke(); }
  ctx.restore();
}
function drawOrb(ctx, t, amp, blink, still, bands) {
  const cx = PANEL / 2, cy = 255, r = 82 + amp * 10;
  const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 190); glow.addColorStop(0, `rgba(212,162,76,${0.35 + amp * 0.35})`); glow.addColorStop(1, "rgba(212,162,76,0)");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, 190, 0, Math.PI * 2); ctx.fill();
  const n = 72, rot = still ? 0 : t * 0.25;
  for (let i = 0; i < n; i++) { const a = rot + (i / n) * Math.PI * 2; const v = bands ? bands[i % bands.length] / 255 : 0.25 + 0.25 * Math.abs(Math.sin(t * 3 + i)); const len = 8 + v * 46 * (0.4 + amp); ctx.strokeStyle = `rgba(232,196,120,${0.35 + v * 0.6})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r + 18), cy + Math.sin(a) * (r + 18)); ctx.lineTo(cx + Math.cos(a) * (r + 18 + len), cy + Math.sin(a) * (r + 18 + len)); ctx.stroke(); }
  const body = ctx.createRadialGradient(cx - 25, cy - 30, 10, cx, cy, r); body.addColorStop(0, "#f6d99c"); body.addColorStop(0.55, C.gold); body.addColorStop(1, "#7a5517");
  ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#0a0e14"; const eh = blink ? 1.5 : 9; for (const ex of [-24, 24]) { ctx.beginPath(); ctx.ellipse(cx + ex, cy - 12, 7, eh, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = "#0a0e14"; const open = Math.min(1, amp * 1.6); ctx.beginPath(); ctx.ellipse(cx, cy + 26, 16 + open * 6, 2 + open * 11, 0, 0, Math.PI * 2); ctx.fill();
}

// ---------------------------------------------------------------- scenes
function drawScene(ctx, scene, p, currency, caption) {
  const x0 = PANEL + 34, w = W - x0 - 34; const m = (n) => formatMoney(n, currency);
  ctx.textBaseline = "alphabetic"; ctx.fillStyle = C.gold; ctx.font = "700 13px 'Segoe UI', Arial, sans-serif"; ctx.fillText(scene.kind === "intro" ? "INAYA BUSINESS OS · YOUR WALKTHROUGH" : "INAYA BUSINESS OS", x0, 56);
  ctx.fillStyle = C.text; ctx.font = "800 28px 'Segoe UI', Arial, sans-serif"; drawText(ctx, scene.title, x0, 94, w, 34, 2);
  let y = 140; ctx.font = "16px 'Segoe UI', Arial, sans-serif";
  const d = scene.data;
  if (scene.kind === "intro") { ctx.fillStyle = C.muted; ctx.font = "18px 'Segoe UI', Arial, sans-serif"; drawText(ctx, scene.text.replace(/^Hello\.\s*/, ""), x0, y + 10, w, 27, 8); }
  else if (scene.kind === "capabilities") {
    d.forEach((f, i) => { const appear = Math.min(1, Math.max(0, p * d.length * 1.3 - i)); if (appear <= 0) return; ctx.globalAlpha = appear; rrect(ctx, x0, y, w, 62, 12); ctx.fillStyle = "rgba(255,255,255,0.05)"; ctx.fill(); ctx.strokeStyle = C.line; ctx.stroke(); ctx.fillStyle = C.text; ctx.font = "700 16px 'Segoe UI', Arial, sans-serif"; ctx.fillText(f.name, x0 + 16, y + 25); ctx.fillStyle = /Beta/.test(f.state) ? C.warn : C.good; ctx.font = "700 11px 'Segoe UI', Arial, sans-serif"; ctx.fillText(f.state.toUpperCase(), x0 + w - 16 - ctx.measureText(f.state.toUpperCase()).width, y + 24); ctx.fillStyle = C.muted; ctx.font = "13.5px 'Segoe UI', Arial, sans-serif"; drawText(ctx, f.why, x0 + 16, y + 46, w - 32, 17, 1); ctx.globalAlpha = 1; y += 72; });
  } else if (scene.kind === "workflow") {
    // highlight exactly the step being spoken (the caption sentence); none during the opening sentence; all when not playing
    const steps = d.steps; const spoken = caption ? steps.findIndex((s) => caption.startsWith(s.slice(0, 18))) : steps.length - 1;
    const active = spoken >= 0 ? spoken : caption && /^Here is how/.test(caption) ? -1 : Math.min(steps.length - 1, Math.floor(p * steps.length));
    steps.forEach((s, i) => { const yy = y + i * 50; const on = i <= active; rrect(ctx, x0 + 30, yy, w - 30, 38, 10); ctx.fillStyle = i === active ? "rgba(212,162,76,0.22)" : on ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)"; ctx.fill(); ctx.strokeStyle = i === active ? C.gold : C.line; ctx.lineWidth = i === active ? 2 : 1; ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = on ? C.gold : "#4b5563"; ctx.beginPath(); ctx.arc(x0 + 12, yy + 19, 11, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = C.bg; ctx.font = "800 12px 'Segoe UI', Arial, sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(i + 1), x0 + 12, yy + 23.5); ctx.textAlign = "left";
      ctx.fillStyle = on ? C.text : C.muted; ctx.font = `${i === active ? "700 " : ""}14.5px 'Segoe UI', Arial, sans-serif`; drawText(ctx, s, x0 + 44, yy + 24, w - 60, 17, 1);
      if (i < steps.length - 1) { ctx.strokeStyle = on ? C.gold : "#4b5563"; ctx.beginPath(); ctx.moveTo(x0 + 12, yy + 31); ctx.lineTo(x0 + 12, yy + 50); ctx.stroke(); } });
  } else if (scene.kind === "cost") {
    const c = d.config; ctx.font = "15px 'Segoe UI', Arial, sans-serif";
    c.lines.forEach((l) => { ctx.fillStyle = C.muted; ctx.fillText(l.label, x0, y + 8); ctx.fillStyle = C.text; const v = m(l.amount); ctx.fillText(v, x0 + w - ctx.measureText(v).width, y + 8); y += 28; });
    ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x0, y - 8); ctx.lineTo(x0 + w, y - 8); ctx.stroke();
    ctx.fillStyle = C.gold; ctx.font = "800 19px 'Segoe UI', Arial, sans-serif"; ctx.fillText("Inaya, per month", x0, y + 16); const tv = m(c.monthlyTotal); ctx.fillText(tv, x0 + w - ctx.measureText(tv).width, y + 16); y += 46;
    if (d.consolidation) {
      const k = d.consolidation; const max = Math.max(k.currentMonthly, k.inayaMonthly, 1); const grow = Math.min(1, p * 2);
      [["Your tools today (your figure)", k.currentMonthly, "#64748b"], ["This Inaya configuration", k.inayaMonthly, C.gold]].forEach(([lab, val, col]) => { ctx.fillStyle = C.muted; ctx.font = "13px 'Segoe UI', Arial, sans-serif"; ctx.fillText(lab, x0, y); rrect(ctx, x0, y + 8, Math.max(6, (w - 110) * (val / max) * grow), 22, 6); ctx.fillStyle = col; ctx.fill(); ctx.fillStyle = C.text; ctx.font = "700 14px 'Segoe UI', Arial, sans-serif"; ctx.fillText(m(val), x0 + w - 100, y + 25); y += 52; });
      ctx.fillStyle = k.difference >= 0 ? C.good : C.warn; ctx.font = "700 15px 'Segoe UI', Arial, sans-serif"; ctx.fillText(k.difference >= 0 ? `Difference: ${m(k.difference)} a month (illustrative)` : `Inaya costs ${m(-k.difference)} a month more on these figures`, x0, y + 6);
    } else { ctx.fillStyle = C.muted; ctx.font = "15px 'Segoe UI', Arial, sans-serif"; drawText(ctx, "You didn't enter what you pay today, so no saving is estimated.", x0, y + 4, w, 21, 2); }
  } else if (scene.kind === "time") {
    ctx.fillStyle = C.text; ctx.font = "800 40px 'Segoe UI', Arial, sans-serif"; ctx.fillText(m(d.currentMonthlyCost), x0, y + 40); ctx.fillStyle = C.muted; ctx.font = "15px 'Segoe UI', Arial, sans-serif"; ctx.fillText(`of time a month on manual work (${d.hoursPerWeek} h/week × ${d.people})`, x0, y + 68);
    if (d.hypotheticalMonthlyValue !== null) { ctx.fillStyle = C.gold; ctx.font = "800 28px 'Segoe UI', Arial, sans-serif"; ctx.fillText(m(d.hypotheticalMonthlyValue), x0, y + 130); ctx.fillStyle = C.muted; ctx.font = "15px 'Segoe UI', Arial, sans-serif"; ctx.fillText(`if it fell by your assumed ${d.reductionPct}% (hypothetical)`, x0, y + 156); }
  } else if (scene.kind === "limits") {
    ctx.font = "14.5px 'Segoe UI', Arial, sans-serif"; d.forEach((l) => { ctx.fillStyle = C.gold; ctx.fillText("•", x0, y + 8); ctx.fillStyle = C.text; y = drawText(ctx, l, x0 + 16, y + 8, w - 16, 19, 3) + 10; });
  } else if (scene.kind === "next") {
    ctx.fillStyle = C.muted; ctx.font = "18px 'Segoe UI', Arial, sans-serif"; y = drawText(ctx, scene.text, x0, y + 16, w, 26, 3) + 22;
    rrect(ctx, x0, y, 300, 52, 14); ctx.fillStyle = C.gold; ctx.fill(); ctx.fillStyle = C.bg; ctx.font = "800 17px 'Segoe UI', Arial, sans-serif"; ctx.fillText("inayanetwork.com/business", x0 + 22, y + 33);
  }
  // captions (the sentence being spoken)
  if (caption) { ctx.font = "15px 'Segoe UI', Arial, sans-serif"; const lines = wrap(ctx, caption, W - 80).slice(-2); const bh = lines.length * 21 + 16; rrect(ctx, 24, H - bh - 14, W - 48, bh, 10); ctx.fillStyle = "rgba(0,0,0,0.72)"; ctx.fill(); ctx.fillStyle = "#fff"; lines.forEach((l, i) => ctx.fillText(l, 40, H - bh - 14 + 26 + i * 21)); }
}

// Scene timing: proportional to how much is said in each scene (+ a short pause).
function captionAt(text, p) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]; const total = text.length; let acc = 0;
  for (const s of sentences) { acc += s.length; if (acc / total >= p) return s.trim(); }
  return sentences[sentences.length - 1].trim();
}

export default function AvatarStage({ script, sceneTokens, currency, track }) {
  const canvas = useRef(null); const raf = useRef(0);
  // AI voice, scene by scene: buffers[i] decoded audio, pending[i] in-flight fetch; scene/offset/startedAt = playhead
  const audio = useRef({ ctx: null, analyser: null, buffers: [], pending: [], scene: 0, source: null, startedAt: 0, offset: 0, recDest: null, recorder: null, run: 0 });
  const speech = useRef({ active: false, scene: 0, charIdx: 0, gen: 0 });
  const blinkAt = useRef(0); const [avatar, setAvatar] = useState("presenter"); const [voice, setVoice] = useState("warm");
  const [state, setState] = useState("idle"); // idle | loading | playing | paused | ended
  const [mode, setMode] = useState(null); // "ai" | "device"
  const [note, setNote] = useState(""); const [sceneIdx, setSceneIdx] = useState(0); const [recording, setRecording] = useState(false);
  const stateRef = useRef(state); stateRef.current = state; const avatarRef = useRef(avatar); avatarRef.current = avatar;
  const modeRef = useRef(mode); modeRef.current = mode;
  const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const scenes = script.scenes; const canAi = Array.isArray(sceneTokens) && sceneTokens.length === scenes.length;
  const go = (s) => { stateRef.current = s; setState(s); };

  // ------------------------------------------------------------ render loop
  const frame = useCallback(() => {
    const cv = canvas.current; if (!cv) return; const ctx = cv.getContext("2d"); const now = performance.now() / 1000;
    let idx = 0, p = 0, amp = 0, bands = null; const a = audio.current;
    if (modeRef.current === "ai") {
      idx = a.scene; const buf = a.buffers[idx];
      if (buf) { const pos = stateRef.current === "playing" && a.source ? a.offset + (a.ctx.currentTime - a.startedAt) : a.offset; p = Math.min(1, Math.max(0, pos / buf.duration)); }
      if (a.analyser && stateRef.current === "playing" && a.source) { const td = new Uint8Array(a.analyser.fftSize); a.analyser.getByteTimeDomainData(td); let sum = 0; for (const v of td) sum += ((v - 128) / 128) ** 2; amp = Math.min(1, Math.sqrt(sum / td.length) * 5); const fb = new Uint8Array(a.analyser.frequencyBinCount); a.analyser.getByteFrequencyData(fb); bands = fb.slice(2, 74); }
    } else if (modeRef.current === "device") {
      idx = speech.current.scene; p = Math.min(1, speech.current.charIdx / Math.max(1, scenes[idx]?.text.length || 1));
      if (stateRef.current === "playing") amp = 0.25 + 0.35 * Math.abs(Math.sin(now * 11)) * (0.6 + 0.4 * Math.sin(now * 3.1));
    }
    if (stateRef.current === "ended") { idx = scenes.length - 1; p = 1; }
    if (idx !== sceneIdx) setSceneIdx(idx);
    if (now > blinkAt.current + 0.13 && Math.random() < 0.006) blinkAt.current = now; const blink = now - blinkAt.current < 0.13;
    ctx.save(); ctx.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#16223a"); g.addColorStop(1, "#0c1322"); rrect(ctx, 14, 14, PANEL - 14, H - 28, 18); ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = "rgba(212,162,76,0.35)"; ctx.stroke();
    ctx.save(); rrect(ctx, 14, 14, PANEL - 14, H - 28, 18); ctx.clip(); if (avatarRef.current === "orb") drawOrb(ctx, now, amp, blink, still, bands); else drawPresenter(ctx, now, amp, blink, still); ctx.restore();
    ctx.fillStyle = C.gold; ctx.font = "700 12px 'Segoe UI', Arial, sans-serif"; ctx.fillText("INAYA GUIDE · AI EXPLAINER", 34, 44);
    const sc = scenes[idx]; const live = stateRef.current === "playing" || stateRef.current === "paused" || stateRef.current === "loading";
    drawScene(ctx, sc, stateRef.current === "idle" ? 1 : p, currency, live ? captionAt(sc.text, p) : null);
    if (stateRef.current === "idle") { ctx.fillStyle = "rgba(10,14,20,0.55)"; ctx.fillRect(PANEL, 0, W - PANEL, H); ctx.fillStyle = C.text; ctx.font = "800 22px 'Segoe UI', Arial, sans-serif"; ctx.fillText("Press Play to start your walkthrough", PANEL + 60, H / 2); }
    ctx.restore();
    raf.current = requestAnimationFrame(frame);
  }, [scenes, sceneIdx, currency, still]);

  useEffect(() => { raf.current = requestAnimationFrame(frame); return () => cancelAnimationFrame(raf.current); }, [frame]);
  useEffect(() => () => { const a = audio.current; a.run++; try { a.source?.stop(); a.ctx?.close(); } catch {} try { window.speechSynthesis?.cancel(); } catch {} }, []);

  // ------------------------------------------------------------ AI voice (scene by scene)
  function ensureCtx() {
    const a = audio.current; if (a.ctx) return a.ctx;
    const AC = window.AudioContext || window.webkitAudioContext; a.ctx = new AC(); a.analyser = a.ctx.createAnalyser(); a.analyser.fftSize = 512; a.analyser.connect(a.ctx.destination); return a.ctx;
  }
  function fetchScene(i) {
    const a = audio.current; if (a.buffers[i]) return Promise.resolve(a.buffers[i]); if (a.pending[i]) return a.pending[i];
    a.pending[i] = (async () => {
      const res = await fetch("/api/why-inaya/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: scenes[i].text, token: sceneTokens[i], voice }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "The AI voice is unavailable right now."); }
      const buf = await ensureCtx().decodeAudioData(await res.arrayBuffer()); a.buffers[i] = buf; return buf;
    })();
    a.pending[i].catch(() => { a.pending[i] = null; });
    return a.pending[i];
  }
  function startSource(i, from) {
    const a = audio.current; const old = a.source; a.source = null; try { old?.stop(); } catch {}
    const src = a.ctx.createBufferSource(); src.buffer = a.buffers[i]; src.connect(a.analyser); if (a.recDest) src.connect(a.recDest);
    const run = a.run;
    src.onended = () => { if (a.source !== src || a.run !== run || stateRef.current !== "playing") return; a.source = null; playScene(i + 1, 0); };
    a.scene = i; a.offset = from; a.startedAt = a.ctx.currentTime; a.source = src; src.start(0, from);
  }
  async function playScene(i, from = 0) {
    const a = audio.current; const run = a.run;
    if (i >= scenes.length) { a.scene = scenes.length - 1; a.offset = 0; go("ended"); track?.("ai_explainer_completed"); if (a.recorder?.state === "recording") a.recorder.stop(); return; }
    a.scene = i; a.offset = from;
    if (!a.buffers[i]) go("loading");
    try { await fetchScene(i); }
    catch (e) { if (a.run !== run) return; setMode("device"); modeRef.current = "device"; setNote(`${e.message} Your device's voice continues from here; the transcript below has every word.`); if (a.recorder?.state === "recording") { a.cancelRec = true; a.recorder.stop(); } go("playing"); speakFrom(i); return; }
    if (a.run !== run) return;
    await a.ctx.resume(); go("playing"); startSource(i, from);
    for (const k of [i + 1, i + 2]) if (k < scenes.length) fetchScene(k).catch(() => {}); // prepare the next scenes while this one plays
  }

  // ------------------------------------------------------------ device voice (fallback)
  function speakFrom(i) {
    const synth = window.speechSynthesis; if (!synth) { setNote("Your browser has no built-in voice. The transcript below has every word."); go("idle"); return; }
    synth.cancel(); const gen = speech.current.gen + 1; speech.current = { active: true, scene: i, charIdx: 0, gen };
    const say = (k) => {
      if (k >= scenes.length) { go("ended"); track?.("ai_explainer_completed"); return; }
      speech.current.scene = k; speech.current.charIdx = 0;
      const u = new SpeechSynthesisUtterance(scenes[k].text); u.lang = "en-GB"; u.rate = 0.98;
      const v = synth.getVoices().find((x) => /en-(GB|US)/.test(x.lang) && /natural|neural|online/i.test(x.name)) || synth.getVoices().find((x) => /^en/.test(x.lang)); if (v) u.voice = v;
      u.onboundary = (e) => { speech.current.charIdx = e.charIndex || 0; };
      u.onend = () => { if (speech.current.active && speech.current.gen === gen && stateRef.current === "playing") say(k + 1); };
      synth.speak(u);
    };
    say(i);
  }

  // ------------------------------------------------------------ controls
  async function play() {
    track?.("ai_audio_play"); setNote("");
    if (state === "paused") {
      if (modeRef.current === "ai") { await audio.current.ctx.resume(); go("playing"); startSource(audio.current.scene, audio.current.offset); } else { window.speechSynthesis?.resume(); go("playing"); }
      return;
    }
    if (modeRef.current === "device" || !canAi) { setMode("device"); modeRef.current = "device"; go("playing"); speakFrom(0); return; }
    setMode("ai"); modeRef.current = "ai"; ensureCtx(); audio.current.run++; playScene(0, 0);
  }
  function pause() {
    if (modeRef.current === "ai") { const a = audio.current; if (a.source) a.offset += a.ctx.currentTime - a.startedAt; const s = a.source; a.source = null; try { s?.stop(); } catch {} }
    else window.speechSynthesis?.pause();
    go("paused");
  }
  function stop() {
    const a = audio.current; a.run++;
    if (modeRef.current === "ai") { const s = a.source; a.source = null; try { s?.stop(); } catch {} a.scene = 0; a.offset = 0; if (a.recorder?.state === "recording") { a.cancelRec = true; a.recorder.stop(); } }
    else { speech.current.active = false; speech.current.gen += 1; window.speechSynthesis?.cancel(); }
    go("idle");
  }
  function replay() {
    stop();
    if (modeRef.current === "ai") { audio.current.run++; playScene(0, 0); } else { go("playing"); speakFrom(0); }
  }
  function download() {
    const a = audio.current; if (modeRef.current !== "ai" || typeof MediaRecorder === "undefined") return;
    stop();
    const stream = canvas.current.captureStream(30); const dest = a.ctx.createMediaStreamDestination(); a.recDest = dest;
    const mixed = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const type = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(mixed, type ? { mimeType: type, videoBitsPerSecond: 3_000_000 } : undefined); const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      a.recDest = null; a.recorder = null; setRecording(false); stream.getTracks().forEach((t) => t.stop());
      if (a.cancelRec) { a.cancelRec = false; return; }
      const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" })); const link = document.createElement("a"); link.href = url; link.download = "inaya-business-os-walkthrough.webm"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    a.recorder = rec; setRecording(true); rec.start(500);
    a.run++; playScene(0, 0);
  }

  const btn = "min-h-[40px] px-4 rounded-lg text-[13px] font-bold border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-40";
  return (
    <div>
      <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-[#0a0e14]">
        <canvas ref={canvas} width={W * 2} height={H * 2} className="block w-full h-auto" role="img" aria-label={`Animated AI guide presenting your walkthrough. Now showing: ${scenes[sceneIdx]?.title}. The full text is in the transcript below.`} />
      </div>
      <p className="sr-only" aria-live="polite">{state === "playing" ? `Now: ${scenes[sceneIdx]?.title}` : ""}</p>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {state === "playing" ? <button type="button" onClick={pause} className={`${btn} border-white/20 text-white`}>⏸ Pause</button>
          : <button type="button" onClick={play} disabled={state === "loading" || recording} className={`${btn} border-transparent text-[#0a0e14]`} style={{ background: C.gold }}>{state === "loading" ? "Preparing the voice…" : state === "paused" ? "▶ Resume" : "▶ Play"}</button>}
        <button type="button" onClick={replay} disabled={state === "idle" || recording} className={`${btn} border-white/20 text-white`}>↺ Replay</button>
        <button type="button" onClick={stop} disabled={state === "idle"} className={`${btn} border-white/20 text-white`}>■ Stop</button>
        <button type="button" onClick={download} disabled={mode !== "ai" || recording || state === "loading"} className={`${btn} border-white/20 text-white`}>{recording ? "Recording… (plays to the end)" : mode !== "ai" ? "⬇ Video (after the AI voice plays)" : "⬇ Download as video"}</button>
        <fieldset className="flex items-center gap-1 ml-auto text-[12.5px] text-[#cbd5e1]"><legend className="sr-only">Guide style</legend>
          {[["presenter", "Presenter"], ["orb", "Orb"]].map(([v, l]) => <label key={v} className={`cursor-pointer rounded-full px-3 py-1.5 border ${avatar === v ? "border-transparent text-[#0a0e14] font-bold" : "border-white/20"}`} style={avatar === v ? { background: C.gold } : undefined}><input type="radio" name="avatar" value={v} aria-label={`${l} guide`} checked={avatar === v} onChange={() => setAvatar(v)} className="sr-only" />{l}</label>)}
        </fieldset>
        {mode === null && canAi && <label className="text-[12.5px] text-[#cbd5e1] flex items-center gap-1.5">Voice <select value={voice} onChange={(e) => setVoice(e.target.value)} className="bg-[#111a2b] border border-white/20 rounded px-2 py-1 text-white"><option value="warm">Warm</option><option value="calm">Calm</option></select></label>}
      </div>
      {state === "loading" && <p role="status" className="text-[12.5px] text-[#cbd5e1] mt-2">Preparing the voice (about 10 to 15 seconds for the first part; the rest is prepared while it plays)…</p>}
      {note && <p role="status" className="text-[12.5px] text-amber-200 mt-2">{note}</p>}
      <p className="text-[11.5px] text-[#94a3b8] mt-2">The guide is a synthetic AI presenter and voice, not a real person or a financial adviser.{mode === "ai" ? " Voice generated by Google Gemini." : mode === "device" ? " Voice: your device's built-in voice." : ""}</p>
    </div>
  );
}
