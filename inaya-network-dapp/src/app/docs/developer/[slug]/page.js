import { notFound } from "next/navigation";
import { getDocBySlug, loadAllDocs, resolveRelatedDocs } from "../../../../lib/docsContent.js";
import Breadcrumbs from "../../../../components/docs/Breadcrumbs.js";
import TableOfContents from "../../../../components/docs/TableOfContents.js";
import StatusBadge from "../../../../components/docs/StatusBadge.js";
import RelatedDocs from "../../../../components/docs/RelatedDocs.js";
import MarkdownRenderer from "../../../../components/docs/MarkdownRenderer.js";

export function generateStaticParams() {
  return loadAllDocs()
    .filter((d) => d.product === "Developer Platform")
    .map((d) => ({ slug: d.slug }));
}

export function generateMetadata({ params }) {
  const doc = getDocBySlug(params.slug);
  if (!doc) return {};
  return { title: doc.title, description: doc.description };
}

export default function DeveloperDocPage({ params }) {
  const doc = getDocBySlug(params.slug);
  if (!doc || doc.product !== "Developer Platform") notFound();

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-10 flex gap-10">
      <div className="min-w-0 flex-1">
        <Breadcrumbs items={[{ label: "Docs", href: "/docs" }, { label: "Developers", href: "/docs/developer/developer-overview" }, { label: doc.title }]} />
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{doc.title}</h1>
          <StatusBadge status={doc.status} />
        </div>
        <p className="text-slate-500 dark:text-slate-400 mb-6">{doc.description}</p>
        <MarkdownRenderer content={doc.content} />
        <RelatedDocs items={resolveRelatedDocs(doc)} />
        <div className="mt-6 text-xs text-slate-400 dark:text-slate-500">Last verified {doc.lastVerifiedAt}</div>
      </div>
      <TableOfContents headings={doc.headings} />
    </div>
  );
}
