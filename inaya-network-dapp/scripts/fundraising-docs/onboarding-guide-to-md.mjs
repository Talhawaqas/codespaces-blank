// scripts/fundraising-docs/onboarding-guide-to-md.mjs
// Writes public/docs/business-workspace-guide.md from the onboarding guide content, so the downloadable
// guide, the AI assistant's source and the PDF all say the same thing.
//   node scripts/fundraising-docs/onboarding-guide-to-md.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceOnboardingGuide as g } from "./content/workspace-onboarding-guide.js";

const out = [`# ${g.cover.title}`, "", `*${g.cover.subtitle}*`, ""];
for (const s of g.sections) {
  out.push(`## ${Number(s.number)}. ${s.title}`, "");
  for (const b of s.blocks) {
    if (b.type === "lead" || b.type === "note") out.push(b.type === "note" ? `> ${b.text}` : b.text, "");
    else if (b.type === "paragraphs") out.push(...b.text.flatMap((t) => [t, ""]));
    else if (b.type === "bullets") out.push(...b.items.map((i) => `- ${i}`), "");
    else if (b.type === "numbered" || b.type === "steps") {
      if (b.lead) out.push(b.lead, "");
      out.push(...b.items.map((i, n) => `${n + 1}. ${typeof i === "string" ? i : `**${i.heading}** ${i.body}`}`), "");
    }
    else if (b.type === "heading") out.push(`### ${b.text}`, "");
    else if (b.type === "stats") out.push(...b.items.map((s) => `- **${s.value}**: ${s.label}`), "");
    else if (b.type === "table") out.push(`| ${b.headers.join(" | ")} |`, `| ${b.headers.map(() => "---").join(" | ")} |`, ...b.rows.map((r) => `| ${r.join(" | ")} |`), "");
  }
}
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/docs/business-workspace-guide.md");
writeFileSync(file, out.join("\n"));
console.log("Wrote", file);
