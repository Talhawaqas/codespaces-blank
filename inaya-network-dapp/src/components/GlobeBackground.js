"use client";

// src/components/GlobeBackground.js
//
// Ambient 3D globe background — a slowly-rotating dark sphere with dotted
// continents and sweeping glow arcs, per the reference video the user
// provided. First Three.js-based feature in this codebase (an explicit,
// deliberate exception to the usual "avoid new dependencies" bias — the
// user chose this over a hand-rolled 2D canvas approximation).
//
// Same shape as NetworkVisualization.js's existing decorative-canvas
// convention: a "use client" component, useRef+useEffect owning its own
// render loop, prefers-reduced-motion handled (one static frame, no
// rotation/arc animation), full cleanup on unmount (cancels the frame,
// disposes the renderer/scene, removes listeners), pointer-events:none +
// aria-hidden on the wrapper so it never intercepts clicks meant for real
// UI underneath it.
//
// HONESTY: the arcs are a small fixed set of illustrative city-to-city
// great-circle paths, cycling with randomized timing -- purely decorative,
// exactly like NetworkVisualization.js's own header comment states for
// its node graph ("no real data feed into this"). Nothing in the UI
// implies these represent live network traffic.
//
// Country outlines: src/data/world-110m.json is a low-resolution (110m)
// Natural Earth countries GeoJSON, bundled as a static asset (same copy
// three-globe ships in its own examples) -- no runtime external fetch for
// a decorative background.

import { useEffect, useRef } from "react";
import worldData from "../data/world-110m.json";

// three / three-globe both touch `window` at module-evaluation time, which
// breaks Next.js's server-side render of this "use client" component's
// module graph (the server bundle still evaluates client-component modules
// for the RSC boundary, even though it never actually renders them). Both
// are dynamically imported inside the effect below instead of statically
// at the top of the file, so the browser-only code never runs during SSR.

const CYAN = "#00f2fe";
const GOLD = "#ffc857";
const BASE_COLOR = "#0b1220";

// A handful of illustrative city coordinates for the decorative arcs --
// not tied to any real telemetry. Cycled randomly, never labeled as live.
const ARC_POINTS = [
  { lat: 40.7128, lng: -74.006 }, // New York
  { lat: 51.5074, lng: -0.1278 }, // London
  { lat: 1.3521, lng: 103.8198 }, // Singapore
  { lat: 35.6762, lng: 139.6503 }, // Tokyo
  { lat: 25.2048, lng: 55.2708 }, // Dubai
  { lat: -33.8688, lng: 151.2093 }, // Sydney
  { lat: 37.7749, lng: -122.4194 }, // San Francisco
  { lat: 52.52, lng: 13.405 }, // Berlin
];

function randomArcs(count) {
  const arcs = [];
  for (let i = 0; i < count; i++) {
    const a = ARC_POINTS[Math.floor(Math.random() * ARC_POINTS.length)];
    let b = ARC_POINTS[Math.floor(Math.random() * ARC_POINTS.length)];
    while (b === a) b = ARC_POINTS[Math.floor(Math.random() * ARC_POINTS.length)];
    arcs.push({
      startLat: a.lat, startLng: a.lng, endLat: b.lat, endLng: b.lng,
      color: Math.random() > 0.5 ? CYAN : GOLD,
    });
  }
  return arcs;
}

const VARIANTS = {
  ambient: { opacity: 0.55, scale: 1, position: "center" },
  subtle: { opacity: 0.18, scale: 0.85, position: "corner" },
};

export default function GlobeBackground({ variant = "ambient", className = "" }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // cancelled flips true if this component unmounts before the dynamic
    // import below resolves -- without this guard, a fast unmount (e.g.
    // rapid navigation) could construct and mount a whole Three.js scene
    // onto a container that's already gone.
    let cancelled = false;
    let cleanupInner = () => {};

    async function init() {
      const [THREE, { default: ThreeGlobe }] = await Promise.all([
        import("three"),
        import("three-globe"),
      ]);
      if (cancelled) return;

      const reducedMotion = typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;

      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(width, height);
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xcccccc, Math.PI));
      scene.add(new THREE.DirectionalLight(0xffffff, 0.6 * Math.PI));

      const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
      camera.position.z = 320;

      const globe = new ThreeGlobe({ animateIn: false })
        .globeMaterial(new THREE.MeshPhongMaterial({ color: BASE_COLOR, transparent: false }))
        .showAtmosphere(true)
        .atmosphereColor(CYAN)
        .atmosphereAltitude(0.18)
        .hexPolygonsData(worldData.features)
        .hexPolygonResolution(3)
        .hexPolygonMargin(0.4)
        .hexPolygonUseDots(true)
        .hexPolygonColor(() => (Math.random() > 0.85 ? GOLD : "#5b6b85"))
        .arcsData(randomArcs(10))
        .arcColor("color")
        .arcAltitude(0.25)
        .arcStroke(0.4)
        .arcDashLength(0.4)
        .arcDashGap(0.6)
        .arcDashAnimateTime(reducedMotion ? 0 : 3500);

      scene.add(globe);

      function resize() {
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      resize();

      // A plain window "resize" listener alone misses the case where the
      // container has zero layout size the instant this effect runs (e.g.
      // right after navigation, before the browser's first layout pass) --
      // that would freeze the canvas at a 1x1 fallback forever, since the
      // window itself never resizes afterward. ResizeObserver re-measures
      // the container directly and corrects the canvas size as soon as real
      // layout is available, in addition to tracking later size changes.
      const resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(container);

      // A guaranteed synchronous first paint, independent of
      // requestAnimationFrame -- some embedding contexts (background/
      // non-focused tabs) throttle or fully suspend rAF callbacks, which
      // would otherwise leave this canvas permanently blank until the tab
      // actually gains focus. This one direct call means the globe is
      // visible immediately regardless of rAF scheduling.
      renderer.render(scene, camera);

      let animationFrame;
      // Always start running -- gating this on an initial visibilityState
      // read was wrong: some embedding contexts report "hidden" even for a
      // foregrounded tab (e.g. an unfocused preview pane), which would
      // permanently stop the loop from ever starting. The visibilitychange
      // listener below still correctly pauses/resumes on real transitions.
      let paused = false;

      function step() {
        if (!reducedMotion) globe.rotation.y += 0.0018;
        renderer.render(scene, camera);
        if (!reducedMotion && !paused) animationFrame = requestAnimationFrame(step);
      }
      // Reduced-motion visitors get exactly one rendered frame -- the globe
      // and continents are still visible, they just never move.
      if (reducedMotion) {
        step();
      } else {
        animationFrame = requestAnimationFrame(step);
      }

      function handleVisibility() {
        paused = document.visibilityState === "hidden";
        if (!paused && !reducedMotion && !animationFrame) {
          animationFrame = requestAnimationFrame(step);
        }
      }
      document.addEventListener("visibilitychange", handleVisibility);
      window.addEventListener("resize", resize);

      cleanupInner = () => {
        cancelAnimationFrame(animationFrame);
        document.removeEventListener("visibilitychange", handleVisibility);
        window.removeEventListener("resize", resize);
        resizeObserver.disconnect();
        scene.remove(globe);
        globe.geometry?.dispose?.();
        renderer.dispose();
        if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
      };
    }

    init().catch((err) => console.error("GlobeBackground: failed to initialize", err));

    return () => {
      cancelled = true;
      cleanupInner();
    };
  }, [variant]);

  const { opacity, scale, position } = VARIANTS[variant] || VARIANTS.ambient;

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-0 overflow-hidden -z-10 ${className}`}
      style={{ opacity }}
    >
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          transform: `scale(${scale})`,
          ...(position === "corner" ? { transformOrigin: "85% 15%" } : { transformOrigin: "50% 50%" }),
        }}
      />
    </div>
  );
}
