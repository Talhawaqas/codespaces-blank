"use client";

// src/components/security/NetworkVisualization.js
//
// Ambient canvas animation for the /security transparency page's hero —
// drifting nodes connecting with nearby neighbors, occasionally pulsing
// red to suggest "a threat was just reported and confirmed." Purely
// decorative (no real data feed into this — the actual stats/threat list
// below it are the real numbers), self-contained canvas + requestAnimationFrame,
// no charting/3D dependency added for one ambient visual.

import { useEffect, useRef } from "react";

const NODE_COUNT_DESKTOP = 55;
const NODE_COUNT_MOBILE = 28;
const CONNECT_DISTANCE = 140;
const NODE_SPEED = 0.12;
const PULSE_INTERVAL_MS = 1800;
const CYAN = "0, 242, 254";
const RED = "248, 113, 113";

export default function NetworkVisualization({ height = 320 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let width = canvas.clientWidth;
    let animationFrame;
    let lastPulse = 0;

    const nodeCount = width < 640 ? NODE_COUNT_MOBILE : NODE_COUNT_DESKTOP;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const reducedMotion = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

    function resize() {
      width = canvas.clientWidth;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    const nodes = Array.from({ length: nodeCount }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * NODE_SPEED,
      vy: (Math.random() - 0.5) * NODE_SPEED,
      r: 1.5 + Math.random() * 1.5,
      pulseUntil: 0,
    }));

    function step(timestamp) {
      ctx.clearRect(0, 0, width, height);

      if (timestamp - lastPulse > PULSE_INTERVAL_MS) {
        lastPulse = timestamp;
        const target = nodes[Math.floor(Math.random() * nodes.length)];
        target.pulseUntil = timestamp + 900;
      }

      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > width) n.vx *= -1;
        if (n.y < 0 || n.y > height) n.vy *= -1;
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < CONNECT_DISTANCE) {
            const opacity = (1 - dist / CONNECT_DISTANCE) * 0.35;
            ctx.strokeStyle = `rgba(${CYAN}, ${opacity})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      for (const n of nodes) {
        const pulsing = timestamp < n.pulseUntil;
        const color = pulsing ? RED : CYAN;
        const glowR = pulsing ? n.r * 4 : n.r * 2.2;

        const gradient = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, glowR);
        gradient.addColorStop(0, `rgba(${color}, ${pulsing ? 0.5 : 0.25})`);
        gradient.addColorStop(1, `rgba(${color}, 0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(${color}, ${pulsing ? 1 : 0.85})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, pulsing ? n.r * 1.6 : n.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Reduced-motion visitors get one static frame instead of a
      // continuous drifting/pulsing loop — still shows the graphic, just
      // never moves.
      if (!reducedMotion) animationFrame = requestAnimationFrame(step);
    }

    animationFrame = requestAnimationFrame(step);

    const handleResize = () => resize();
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", handleResize);
    };
  }, [height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: `${height}px`, display: "block" }}
      className="rounded-2xl"
      aria-hidden="true"
    />
  );
}
