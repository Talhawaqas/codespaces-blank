// src/components/Skeleton.js
//
// Small reusable loading placeholder, matching the app's existing stat-card
// shape (bg-[#0b1120]/40 border-l-4 p-5 rounded-r-xl) so a loading grid
// looks like a preview of the real one filling in, not a layout jump.
// Uses Tailwind's built-in animate-pulse (already used sparingly elsewhere
// in page.js) rather than inventing a new animation.

export function SkeletonStatCard({ borderColor = "border-[#00f2fe]" }) {
  return (
    <div className={`bg-[#0b1120]/40 border-l-4 ${borderColor} p-5 rounded-r-xl animate-pulse`}>
      <div className="h-6 w-20 bg-white/10 rounded mb-2" />
      <div className="h-2.5 w-24 bg-white/5 rounded" />
    </div>
  );
}

export default function Skeleton({ count = 4, borderColors }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonStatCard key={i} borderColor={borderColors?.[i]} />
      ))}
    </div>
  );
}
