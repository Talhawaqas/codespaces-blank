import Link from "next/link";

export default function Breadcrumbs({ items }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm text-slate-500 dark:text-slate-400">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden="true">/</span>}
            {item.href && i !== items.length - 1 ? (
              <Link href={item.href} className="hover:text-slate-900 dark:hover:text-white hover:underline">
                {item.label}
              </Link>
            ) : (
              <span className={i === items.length - 1 ? "text-slate-900 dark:text-white font-medium" : ""} aria-current={i === items.length - 1 ? "page" : undefined}>
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
