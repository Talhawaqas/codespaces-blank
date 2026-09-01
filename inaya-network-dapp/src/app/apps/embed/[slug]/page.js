// app/apps/embed/[slug]/page.js
//
// Server component — fetches the approved listing directly (no client
// round trip needed) and renders it inside a STRICTLY sandboxed iframe.
//
// THE SECURITY-CRITICAL LINE IS THE sandbox ATTRIBUTE BELOW. It grants
// allow-scripts and allow-forms (the app needs to actually run) and
// allow-popups (so a normal "open in new tab" link inside the app still
// works) but DELIBERATELY OMITS allow-same-origin. That omission is the
// entire point: without allow-same-origin, the iframe's content is
// treated as an opaque, unique origin no matter what it does — it cannot
// read or write cookies/localStorage tied to its own real origin, and it
// was never able to reach Inaya's own origin either way (iframes are
// cross-origin-isolated from their parent by default). Combining
// allow-same-origin with allow-scripts is the well-known dangerous
// pattern (the sandboxed content regains full access to its real origin
// while still being able to run script) — never add it here.
//
// getListingBySlug() only ever returns status:"approved" listings, so an
// unapproved or rejected slug 404s here rather than rendering anything.

import { notFound } from "next/navigation";
import { getListingBySlug } from "../../../../lib/appStoreListings";

export default async function AppEmbedPage({ params }) {
  const { slug } = await params;
  const listing = await getListingBySlug(slug);
  if (!listing || listing.hostType !== "iframe") notFound();

  return (
    <div className="min-h-screen bg-[#060913] flex flex-col">
      <div className="bg-amber-400/10 border-b border-amber-400/30 px-4 py-2.5 text-center">
        <p className="text-amber-400 text-xs font-bold">
          ⚠️ &quot;{listing.name}&quot; is hosted and run by its own developer, not Inaya — Inaya only lists it. Verify you trust it before connecting a wallet inside.
        </p>
      </div>
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <a href="/apps" className="text-[#8a96ab] text-sm hover:text-[#00f2fe] transition-colors">← App Store</a>
        <span className="text-white font-bold text-sm">{listing.name}</span>
        <a href={listing.embedUrl} target="_blank" rel="noopener noreferrer" className="text-[#00f2fe] text-xs font-bold">Open in new tab ↗</a>
      </div>
      <iframe
        src={listing.embedUrl}
        title={listing.name}
        className="flex-1 w-full border-0"
        sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
