"use client";

// src/components/business/commerce/CameraScanner.js -- Inaya Commerce: scan barcodes with the device camera (post-SOW,
// beta). Phones and tablets (back camera) and laptops (webcam). Uses the browser's own barcode reader where it has one
// (Chrome on Android, macOS), otherwise the ZXing reader (Windows, iPhone / iPad, Linux), loaded only when the camera is
// opened. The same code is not reported twice within 1.5 seconds, so holding the camera still does not add items twice.
import { useEffect, useRef, useState } from "react";

const btn = "min-h-[40px] px-3 rounded-lg text-sm font-semibold border border-[var(--inaya-border)] bg-[var(--inaya-surface)] text-[var(--inaya-text-primary)] hover:border-[var(--inaya-accent)] disabled:opacity-40";
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf", "codabar", "qr_code", "data_matrix"];

export function cameraAvailable() { return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia; }

/** Opens the camera and calls onCode(text) for every new code read. `continuous`: keep scanning after a read. */
export function CameraScanner({ onCode, onClose, continuous = true }) {
  const videoRef = useRef(null); const [state, setState] = useState("starting"); const [last, setLast] = useState(""); const seen = useRef({ code: "", at: 0 });
  useEffect(() => {
    let stop = () => {}; let cancelled = false;
    const report = (code) => {
      const now = Date.now(); if (!code || (code === seen.current.code && now - seen.current.at < 1500)) return;
      seen.current = { code, at: now }; setLast(code); try { navigator.vibrate?.(60); } catch { /* no vibration */ }
      onCode(code); if (!continuous) onClose?.();
    };
    (async () => {
      if (!cameraAvailable()) { setState("unsupported"); return; }
      try {
        const native = typeof window !== "undefined" && "BarcodeDetector" in window ? await window.BarcodeDetector.getSupportedFormats?.().catch(() => []) : [];
        if (native?.length) {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
          if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
          const v = videoRef.current; v.srcObject = stream; await v.play(); setState("scanning");
          const detector = new window.BarcodeDetector({ formats: FORMATS.filter((f) => native.includes(f)) });
          let raf = 0; let busy = false;
          const tick = async () => { if (cancelled) return; if (!busy && v.readyState >= 2) { busy = true; try { const found = await detector.detect(v); if (found[0]?.rawValue) report(found[0].rawValue); } catch { /* frame not ready */ } busy = false; } raf = requestAnimationFrame(tick); };
          raf = requestAnimationFrame(tick);
          stop = () => { cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); };
        } else {
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 120 });
          const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false }, videoRef.current, (res) => { if (res) report(res.getText()); });
          if (cancelled) { controls.stop(); return; }
          setState("scanning"); stop = () => controls.stop();
        }
      } catch (e) { setState(e?.name === "NotAllowedError" ? "denied" : e?.name === "NotFoundError" ? "nocamera" : "error"); }
    })();
    return () => { cancelled = true; stop(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const text = { starting: "Starting the camera…", scanning: "Point the camera at a barcode.", unsupported: "This browser can't use the camera.", denied: "Camera access was blocked. Allow the camera for this site in the browser settings, then try again.", nocamera: "No camera found on this device.", error: "The camera could not start. Close other apps using it and try again." }[state];
  return <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3" role="dialog" aria-label="Scan with camera">
    <div className="w-full max-w-md rounded-xl bg-[var(--inaya-surface)] border border-[var(--inaya-border)] p-3 space-y-2">
      <div className="relative rounded-lg overflow-hidden bg-black aspect-[4/3]">
        <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
        {state === "scanning" && <div className="absolute inset-x-8 top-1/2 h-0.5 bg-red-500/80 shadow-[0_0_8px_red]" aria-hidden="true" />}
      </div>
      <p className="text-sm" role="status">{text}</p>
      {last && <p className="text-sm">Last read: <b className="font-mono">{last}</b></p>}
      <button className={`${btn} w-full`} onClick={onClose} autoFocus>Done</button>
    </div>
  </div>;
}

// ================================================================= phone as a scanner (the till's side)
const PAIR_KEY = (orgId) => `pos:phone-scanner:${orgId}`;
const loadPair = (orgId) => { try { const p = JSON.parse(sessionStorage.getItem(PAIR_KEY(orgId)) || "null"); return p && Date.parse(p.expiresAt) > Date.now() ? p : null; } catch { return null; } };
const savePair = (orgId, p) => { try { if (p) sessionStorage.setItem(PAIR_KEY(orgId), JSON.stringify(p)); else sessionStorage.removeItem(PAIR_KEY(orgId)); } catch { /* storage blocked */ } };

/** Keeps a phone pairing for this till and delivers its codes to onCode (polls once a second while paired). */
export function usePhoneScanner({ orgId, registerId, onCode }) {
  const [pair, setPairState] = useState(() => (typeof window === "undefined" ? null : loadPair(orgId))); const [seenAt, setSeenAt] = useState(null); const [err, setErr] = useState("");
  const cb = useRef(onCode); cb.current = onCode;
  const setPair = (p) => { setPairState(p); savePair(orgId, p); };
  const start = async () => {
    setErr(""); const r = await fetch("/api/orgs/commerce/scanner/pair", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, registerId: registerId || null }) });
    const d = await r.json().catch(() => ({})); if (!r.ok) { setErr(d.error || "Could not start."); return null; }
    const p = { pairId: d.pairId, token: d.token, expiresAt: d.expiresAt, after: 0 }; setPair(p); return p;
  };
  const end = async () => { const p = pair; setPair(null); setSeenAt(null); if (p) await fetch(`/api/orgs/commerce/scanner/${p.pairId}/end`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId }) }).catch(() => {}); };
  useEffect(() => {
    if (!pair) return undefined; let after = pair.after || 0; let stopped = false;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/orgs/commerce/scanner/${pair.pairId}?orgId=${orgId}&after=${after}`, { credentials: "include", cache: "no-store" }); if (!r.ok) return;
        const d = await r.json(); if (stopped) return;
        setSeenAt(d.phoneSeenAt || null);
        for (const x of d.codes || []) { if (x.seq > after) { after = x.seq; cb.current(x.code); } }
        savePair(orgId, { ...pair, after });
        if (!d.active) { setPair(null); setSeenAt(null); }
      } catch { /* offline: the phone's codes wait on the server */ }
    }, 1000);
    return () => { stopped = true; clearInterval(t); };
  }, [pair?.pairId, orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { pair, seenAt, err, start, end };
}

/** The QR code a phone scans to become this till's scanner. */
export function PhonePairDialog({ phone, onClose }) {
  const [qr, setQr] = useState(""); const url = phone.pair ? `${window.location.origin}/business/pos-scan#t=${phone.pair.token}` : "";
  useEffect(() => { if (!phone.pair) phone.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!url) return; import("qrcode").then((Q) => Q.default.toDataURL(url, { margin: 1, width: 240 })).then(setQr).catch(() => setQr("")); }, [url]);
  return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3" role="dialog" aria-label="Use a phone as a scanner">
    <div className="w-full max-w-sm rounded-xl bg-[var(--inaya-surface)] border border-[var(--inaya-border)] p-4 space-y-2 text-sm">
      <h3 className="font-bold text-base">Use a phone as the scanner <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border border-amber-500 text-amber-600 ml-1">Beta</span></h3>
      {phone.err && <p className="text-red-500">{phone.err}</p>}
      {!phone.pair ? <p>Preparing…</p> : <>
        <p>Scan this with the phone's camera app. The phone opens a scanner page (no sign-in needed); every barcode it reads appears here.</p>
        {qr ? <img src={qr} alt="QR code to connect a phone" className="mx-auto bg-white p-2 rounded-lg" width={240} height={240} /> : <p>Making the QR code…</p>}
        <p className="text-xs text-[var(--inaya-text-muted)]">{phone.seenAt ? "Phone connected." : "Waiting for the phone…"} The connection lasts 12 hours or until you end it.</p>
      </>}
      <div className="flex gap-2"><button className={btn} onClick={onClose} autoFocus>Done</button>{phone.pair && <button className={btn} onClick={async () => { await phone.end(); onClose(); }}>Disconnect the phone</button>}</div>
    </div>
  </div>;
}
