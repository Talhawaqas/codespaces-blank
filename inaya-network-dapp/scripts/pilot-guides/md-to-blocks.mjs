// scripts/pilot-guides/md-to-blocks.mjs
//
// Converts a real markdown document (a product docs page, a README, a runbook) into the block schema the guide template renders
// (lead / paragraphs / bullets / numbered / table / note / code / subsection). Commands, tables and steps come through VERBATIM, so the guide
// can never drift from the documentation it is built from. Inline markdown (bold, italics, code, links) is reduced to plain text; the template
// escapes everything, so nothing in a source document can inject markup.

const stripInline = (s) => String(s ?? "")
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (m, text, url) => (/^https?:\/\//.test(url) ? `${text} (${url})` : text))
  .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1")
  .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2").replace(/`([^`]+)`/g, "$1")
  .replace(/&nbsp;/g, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[a-z][^>]*>/gi, "")
  .replace(/\s+\n/g, "\n").trim();

export function stripFrontmatter(md) {
  const text = String(md).replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { front: {}, body: text };
  const end = text.indexOf("\n---", 4); if (end < 0) return { front: {}, body: text };
  const front = {}; for (const line of text.slice(4, end).split("\n")) { const m = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (m) front[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  return { front, body: text.slice(end + 4).replace(/^\n/, "") };
}

const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => stripInline(c.replace(/\\\|/g, "|")));
const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** @returns {{ title: string|null, blocks: object[] }} */
export function mdToBlocks(md, { skipH1 = true, headingLevelOffset = 0, maxBlocks = 4000 } = {}) {
  const { body } = stripFrontmatter(md);
  const lines = body.split("\n"); const blocks = []; let title = null; let i = 0; let para = [];
  const flush = () => { if (para.length) { const text = stripInline(para.join(" ")); if (text) blocks.push({ type: "paragraphs", text: [text] }); para = []; } };

  while (i < lines.length && blocks.length < maxBlocks) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) { flush(); const marker = fence[1]; const lang = fence[2]; const code = []; i++; while (i < lines.length && !lines[i].trim().startsWith(marker)) { code.push(lines[i]); i++; } i++; blocks.push({ type: "code", label: lang && lang !== "text" ? lang : undefined, text: code.join("\n").replace(/\s+$/, "") }); continue; }
    // headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const level = h[1].length; const text = stripInline(h[2]); if (level === 1 && skipH1) { if (!title) title = text; } else blocks.push({ type: "subsection", heading: text, level: level + headingLevelOffset }); i++; continue; }
    // table
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush(); const headers = splitRow(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { const r = splitRow(lines[i]); while (r.length < headers.length) r.push(""); rows.push(r.slice(0, Math.max(headers.length, r.length))); i++; }
      blocks.push({ type: "table", headers, rows }); continue;
    }
    // blockquote -> note
    if (/^\s*>/.test(line)) { flush(); const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; } const t = stripInline(q.join(" ")); if (t) blocks.push({ type: "note", text: t }); continue; }
    // lists (bullet or numbered), with simple continuation lines and one level of nesting flattened
    const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/); const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flush(); const ordered = !!numbered; const items = [];
      while (i < lines.length) {
        const b = lines[i].match(/^(\s*)([-*+])\s+(.*)$/); const n = lines[i].match(/^(\s*)(\d+)[.)]\s+(.*)$/);
        const m = ordered ? n || (b && b[1].length > 0 ? b : null) : b || (n && n[1].length > 0 ? n : null);
        if (m) { const nested = m[1].length > 1 && items.length; const text = m[3]; if (nested) items[items.length - 1] += `\n– ${text}`; else items.push(text); i++; continue; }
        if (lines[i].trim() === "") { // a blank line ends the list unless the next non-blank line continues it
          let j = i + 1; while (j < lines.length && lines[j].trim() === "") j++;
          if (j < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[j]) : /^\s*[-*+]\s+/.test(lines[j]))) { i = j; continue; }
          break;
        }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; continue; }
        break;
      }
      const clean = items.map(stripInline);
      if (ordered) blocks.push({ type: "numbered", items: clean.map((t) => { const bold = t.match(/^([^.:]{2,80}[.:])\s+([\s\S]*)$/); return bold ? { heading: bold[1], body: bold[2] } : { heading: "", body: t }; }) });
      else blocks.push({ type: "bullets", items: clean });
      continue;
    }
    if (line.trim() === "") { flush(); i++; continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flush(); i++; continue; }
    para.push(line.trim()); i++;
  }
  flush();
  // merge consecutive single-paragraph blocks into one "paragraphs" block
  const merged = [];
  for (const b of blocks) { const last = merged[merged.length - 1]; if (b.type === "paragraphs" && last && last.type === "paragraphs") last.text.push(...b.text); else merged.push(b); }
  return { title, blocks: merged };
}
