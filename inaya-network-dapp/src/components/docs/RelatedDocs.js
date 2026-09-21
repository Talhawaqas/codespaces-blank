import Link from "next/link";

export default function RelatedDocs({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-10 border-t border-slate-200 dark:border-slate-700 pt-6">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">Related documentation</h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((doc) => (
          <li key={doc.slug}>
            <Link
              href={`/docs/products/${doc.slug}`}
              className="block rounded-lg border border-slate-200 dark:border-slate-700 p-3 hover:border-[#0B63E5] dark:hover:border-[#5AA9FF] transition-colors"
            >
              <div className="text-sm font-medium text-slate-900 dark:text-white">{doc.title}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{doc.description}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
