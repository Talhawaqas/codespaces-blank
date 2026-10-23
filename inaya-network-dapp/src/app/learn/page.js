// app/learn/page.js
//
// Inaya Learn lives as a tab inside the main app at '/' (no real routing there),
// so /learn — linked from the RAG sources and shared externally — redirects to
// the home page's allowlisted deep link, which opens the Learn tab.

import { redirect } from "next/navigation";

export default function LearnRedirect() {
  redirect("/?page=learn");
}
