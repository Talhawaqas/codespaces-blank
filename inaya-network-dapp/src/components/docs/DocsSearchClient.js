"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import StatusBadge from "./StatusBadge.js";

/** A real, small keyword index -- not the semantic RAG pipeline. See
 *  docs/architecture/information-architecture.md for why the two are kept
 *  separate. Matches on title/description/tags/heading text, ranks title
 *  matches above body matches. */
function search(index, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return index
    .map((doc) => {
      let score = 0;
      if (doc.title.toLowerCase().includes(q)) score += 10;
      if (doc.description.toLowerCase().includes(q)) score += 4;
      if (doc.tags.some((t) => t.toLowerCase().includes(q))) score += 6;
      if (doc.headings.some((h) => h.toLowerCase().includes(q))) score += 3;
      return { doc, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.doc);
}

function hrefFor(doc) {
  if (doc.contentType === "API Reference") return `/docs/api/${doc.slug}`;
  if (doc.contentType === "SDK Reference") return `/docs/sdk/${doc.slug}`;
  if (doc.contentType === "CLI Reference") return `/docs/cli/${doc.slug}`;
  if (doc.product === "Developer Platform") return `/docs/developer/${doc.slug}`;
  return `/docs/products/${doc.slug}`;
}

export default function DocsSearchClient({ index }) {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");

  useEffect(() => {
    setQuery(searchParams.get("q") || "");
  }, [searchParams]);

  const results = useMemo(() => search(index, query), [index, query]);

  return (
    <div>
      <label htmlFor="docs-search-input" className="sr-only">Search Inaya documentation</label>
      <input
        id="docs-search-input"
        type="search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search storage, S3, SDK, Security API, permissions..."
        className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0B63E5]"
      />

      <div className="mt-6">
        {query.trim() === "" ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Start typing to search {index.length} documentation pages.</p>
        ) : results.length === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            <p>No results for &ldquo;{query}&rdquo;.</p>
            <ul className="mt-3 space-y-1">
              <li>Try a broader term, or browse <Link href="/docs" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">all documentation</Link>.</li>
              <li>Ask the <Link href="/" className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline">AI Docs Assistant</Link> on the main site instead — it can answer in plain language and cites its sources.</li>
            </ul>
          </div>
        ) : (
          <ul className="space-y-2">
            {results.map((doc) => (
              <li key={doc.slug}>
                <Link
                  href={hrefFor(doc)}
                  className="block rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:border-[#0B63E5] dark:hover:border-[#5AA9FF]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-900 dark:text-white">{doc.title}</span>
                    <StatusBadge status={doc.status} className="shrink-0" />
                  </div>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{doc.description}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{doc.product} · {doc.contentType}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
