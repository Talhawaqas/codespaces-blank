"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function CodeBlock({ className, children }) {
  const [copied, setCopied] = useState(false);
  const language = (className || "").replace("language-", "");
  const text = String(children).replace(/\n$/, "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. non-secure context) -- fail quietly, nothing to recover.
    }
  }

  return (
    <div className="relative group my-4 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
      {language && (
        <div className="flex items-center justify-between bg-slate-100 dark:bg-slate-800 px-3 py-1.5 text-xs font-mono text-slate-500 dark:text-slate-400">
          <span>{language}</span>
        </div>
      )}
      <button
        onClick={copy}
        className="absolute right-2 top-2 rounded-md bg-slate-800/80 hover:bg-slate-800 text-white text-xs px-2 py-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        style={language ? { top: "2.25rem" } : undefined}
        aria-label="Copy code to clipboard"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto bg-slate-900 text-slate-100 p-4 text-sm">
        <code>{text}</code>
      </pre>
    </div>
  );
}

const components = {
  h2: ({ node, ...props }) => {
    const id = String(props.children).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    return <h2 id={id} className="text-xl font-bold text-slate-900 dark:text-white mt-8 mb-3 scroll-mt-24" {...props} />;
  },
  h3: ({ node, ...props }) => {
    const id = String(props.children).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    return <h3 id={id} className="text-lg font-semibold text-slate-900 dark:text-white mt-6 mb-2 scroll-mt-24" {...props} />;
  },
  p: ({ node, ...props }) => <p className="text-slate-700 dark:text-slate-300 leading-relaxed mb-4" {...props} />,
  ul: ({ node, ...props }) => <ul className="list-disc list-outside ml-5 space-y-1.5 mb-4 text-slate-700 dark:text-slate-300" {...props} />,
  ol: ({ node, ...props }) => <ol className="list-decimal list-outside ml-5 space-y-1.5 mb-4 text-slate-700 dark:text-slate-300" {...props} />,
  li: ({ node, ...props }) => <li {...props} />,
  a: ({ node, ...props }) => <a className="text-[#0B63E5] dark:text-[#5AA9FF] hover:underline" {...props} />,
  strong: ({ node, ...props }) => <strong className="font-semibold text-slate-900 dark:text-white" {...props} />,
  table: ({ node, ...props }) => (
    <div className="overflow-x-auto my-4">
      <table className="min-w-full text-sm border-collapse" {...props} />
    </div>
  ),
  th: ({ node, ...props }) => <th className="border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-left font-semibold text-slate-900 dark:text-white" {...props} />,
  td: ({ node, ...props }) => <td className="border border-slate-200 dark:border-slate-700 px-3 py-2 text-slate-700 dark:text-slate-300 align-top" {...props} />,
  code: ({ node, className, children, ...props }) => {
    const isBlock = /language-/.test(className || "") || String(children).includes("\n");
    if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
    return (
      <code className="bg-slate-100 dark:bg-slate-800 text-[#0B63E5] dark:text-[#5AA9FF] px-1.5 py-0.5 rounded text-[0.85em] font-mono" {...props}>
        {children}
      </code>
    );
  },
  pre: ({ node, children }) => <>{children}</>,
};

export default function MarkdownRenderer({ content }) {
  return (
    <div className="docs-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
