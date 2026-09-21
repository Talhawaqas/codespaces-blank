"use client";

export default function TableOfContents({ headings }) {
  if (!headings || headings.length === 0) return null;
  return (
    <nav aria-label="On this page" className="sticky top-20 hidden xl:block w-56 shrink-0 text-sm">
      <div className="font-semibold text-slate-900 dark:text-white mb-2">On this page</div>
      <ul className="space-y-1.5 border-l border-slate-200 dark:border-slate-700">
        {headings.map((h) => (
          <li key={h.id} className={h.level === 3 ? "pl-6" : "pl-3"}>
            <a
              href={`#${h.id}`}
              className="block text-slate-500 dark:text-slate-400 hover:text-[#0B63E5] dark:hover:text-[#5AA9FF] -ml-px border-l border-transparent hover:border-[#0B63E5] pl-3 py-0.5"
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
