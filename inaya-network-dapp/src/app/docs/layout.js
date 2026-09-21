import DocsShell from "../../components/docs/DocsShell.js";

export const metadata = {
  title: { default: "Inaya Documentation", template: "%s | Inaya Docs" },
  description: "Official Inaya Network documentation — product guides, API reference, SDK reference, and CLI reference.",
};

export default function DocsLayout({ children }) {
  return <DocsShell>{children}</DocsShell>;
}
