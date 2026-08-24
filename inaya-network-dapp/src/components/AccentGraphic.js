// src/components/AccentGraphic.js
//
// Small, restrained SVG accents for tabs that are otherwise pure text +
// stat boxes (Staking, Faucet) -- the site's only real illustration today
// is NetworkVisualization.js, used solely on /security. Deliberately NOT
// a full canvas animation like that one; this is pure CSS-animated SVG
// (opacity/scale on circles), same "line + node, cyan/gold, restrained"
// visual language, cheap to render, and respects prefers-reduced-motion
// via the .inaya-fade-in-up sibling rules in globals.css -- here the ring
// animation itself uses its own reduced-motion guard below.

const VARIANTS = {
  staking: {
    label: "Concentric rings representing compounding stake rewards",
    rings: [28, 44, 60],
    color: "#00f2fe",
    accent: "#c9a24d",
  },
  faucet: {
    label: "Ripple rings representing a token drip",
    rings: [22, 36, 50],
    color: "#4facfe",
    accent: "#00f2fe",
  },
  business: {
    label: "Concentric rings representing a company's nested document structure",
    rings: [26, 42, 58],
    color: "#a78bfa",
    accent: "#00f2fe",
  },
};

export default function AccentGraphic({ variant = "staking", size = 140 }) {
  const config = VARIANTS[variant] || VARIANTS.staking;
  const center = size / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={config.label}
      className="opacity-90"
    >
      {config.rings.map((r, i) => (
        <circle
          key={r}
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={config.color}
          strokeWidth="1"
          opacity="0.25"
          className="inaya-accent-ring"
          style={{ animationDelay: `${i * 0.5}s` }}
        />
      ))}
      <circle cx={center} cy={center} r="10" fill={config.accent} opacity="0.9" />
      <circle cx={center} cy={center} r="4" fill="#060913" />
    </svg>
  );
}
