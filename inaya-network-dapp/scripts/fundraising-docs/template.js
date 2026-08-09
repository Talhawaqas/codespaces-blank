// Turns the structured content objects (content/*.js) into HTML, which
// generate.mjs then prints to PDF via a headless browser. Keep this file
// free of content — it only knows how to LAY OUT whatever content it's
// given. See brand.css for all visual styling.

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Preserves the deliberate \n line breaks some content uses (e.g. table
// cells with a heading + subtext) without allowing arbitrary HTML injection.
function escMultiline(str) {
  return esc(str).replace(/\n/g, "<br/>");
}

function renderBlock(block) {
  switch (block.type) {
    case "lead":
      return `<p class="lead">${escMultiline(block.text)}</p>`;

    case "paragraphs":
      return block.text.map((p) => `<p class="lead">${escMultiline(p)}</p>`).join("\n");

    case "columns": {
      const colClass = block.items.length === 2 ? "columns two" : "columns";
      const cards = block.items
        .map(
          (item) => `
        <div class="card">
          <h2 class="block-heading">${esc(item.heading)}</h2>
          <p>${escMultiline(item.body)}</p>
        </div>`
        )
        .join("\n");
      return `<div class="${colClass}">${cards}</div>`;
    }

    case "bullets": {
      const lead = block.lead ? `<p class="lead">${escMultiline(block.lead)}</p>` : "";
      const items = block.items.map((i) => `<li>${escMultiline(i)}</li>`).join("\n");
      return `${lead}<ul class="bullets">${items}</ul>`;
    }

    case "numbered": {
      const items = block.items
        .map((i) => `<li><strong>${esc(i.heading)}</strong> ${escMultiline(i.body)}</li>`)
        .join("\n");
      return `<ol class="numbered">${items}</ol>`;
    }

    case "table": {
      const head = block.headers.map((h) => `<th>${esc(h)}</th>`).join("");
      const rows = block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escMultiline(cell)}</td>`).join("")}</tr>`)
        .join("\n");
      return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }

    case "note": {
      const label = block.label ? `<span class="note-label">${esc(block.label)} </span>` : "";
      return `<div class="note">${label}${escMultiline(block.text)}</div>`;
    }

    case "quote":
      return `<p class="quote">${escMultiline(block.text)}</p>`;

    // A labeled sub-block within a section (e.g. Section 05's "Problem 1-6",
    // Section 13's "Principle One-Five") — GTM's dominant structural pattern.
    case "subsection": {
      const paraHtml = block.body ? `<p class="lead">${escMultiline(block.body)}</p>` : "";
      const bulletsHtml = block.bullets
        ? `<ul class="bullets">${block.bullets.map((b) => `<li>${escMultiline(b)}</li>`).join("")}</ul>`
        : "";
      return `<div class="subsection"><h3 class="subsection-heading">${esc(block.heading)}</h3>${paraHtml}${bulletsHtml}</div>`;
    }

    // A full-page Part divider (Part I/II/III title pages).
    case "divider":
      return `
        <div class="divider">
          <div class="divider-kicker">${esc(block.kicker)}</div>
          <h1 class="divider-title">${esc(block.title)}</h1>
          ${block.subtitle ? `<p class="divider-subtitle">${escMultiline(block.subtitle)}</p>` : ""}
        </div>`;

    case "profile": {
      const paras = block.paragraphs.map((p) => `<p>${escMultiline(p)}</p>`).join("\n");
      return `<div class="profile"><p class="name">${esc(block.name)}</p>${paras}</div>`;
    }

    default:
      throw new Error(`Unknown block type: ${block.type}`);
  }
}

function pageShell(bodyHtml) {
  return `<div class="page">${bodyHtml}</div>`;
}

export function buildExecutiveSummaryHTML(content) {
  const { meta, columns, footer } = content;

  const renderColumn = (blocks) =>
    blocks
      .map((section) => {
        const bulletsHtml = section.bullets
          ? `<ul class="bullets">${section.bullets.map((b) => `<li>${escMultiline(b)}</li>`).join("")}</ul>`
          : "";
        const trailerHtml = section.trailer ? `<p class="lead" style="margin-top:2mm;">${escMultiline(section.trailer)}</p>` : "";
        const bodyHtml = section.body ? `<p class="lead">${escMultiline(section.body)}</p>` : "";
        const milestonesHtml = section.milestones
          ? `<ul class="bullets">${section.milestones
              .map((m) => `<li><strong>${esc(m.label)}</strong> ${escMultiline(m.text)}</li>`)
              .join("")}</ul>`
          : "";
        return `
          <div class="exec-block">
            <h2 class="block-heading">${esc(section.heading)}</h2>
            ${bodyHtml}${bulletsHtml}${trailerHtml}${milestonesHtml}
          </div>`;
      })
      .join("\n");

  const body = `
    <div class="header-band">
      <div>
        <div class="brand">${esc(meta.title)}</div>
        <div class="kicker">${esc(meta.kicker)}</div>
      </div>
      <div class="meta">
        <div class="badge">${esc(meta.badge)}</div>
        <div class="date">${esc(meta.date)}</div>
      </div>
    </div>
    <div class="section-body">
      <div class="columns two">
        <div>${renderColumn(columns[0])}</div>
        <div>${renderColumn(columns[1])}</div>
      </div>
    </div>
    <div class="footer-panel">
      <div class="contact">${esc(footer.contact)}</div>
      <div class="note-text">${esc(footer.note)}</div>
    </div>
  `;

  return `<!doctype html><html><head><meta charset="utf-8"/></head><body><div class="page page-compact">${body}</div></body></html>`;
}

export function buildInvestmentMemorandumHTML(content) {
  const { cover, sections, docId } = content;

  const coverPage = pageShell(`
    <div class="header-band">
      <div>
        <div class="brand">${esc(cover.company)}</div>
      </div>
      <div class="meta">
        <div class="badge">${esc(cover.classification)}</div>
      </div>
    </div>
    <div class="cover-title-block">
      <div class="cover-kicker">${esc(cover.kicker)}</div>
      <h1>${esc(cover.title)}</h1>
      <p class="subtitle">${esc(cover.subtitle)}</p>
      <div class="doc-line">${esc(cover.docLine)}</div>
    </div>
  `);

  const sectionPages = sections
    .map((section) => {
      const blocksHtml = section.blocks.map(renderBlock).join("\n");
      return pageShell(`
        <div class="running-header">
          <div class="doc-title">${esc(cover.company)}</div>
          <div>${esc(docId)}</div>
        </div>
        <div class="section-body">
          <div class="section-number">SECTION ${esc(section.number)}</div>
          <h1 class="section-title">${esc(section.title)}</h1>
          ${blocksHtml}
        </div>
        <div class="running-footer">
          <div>${esc(cover.company)}</div>
          <div>${esc(docId)}</div>
        </div>
      `);
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"/></head><body>${coverPage}${sectionPages}</body></html>`;
}

export function buildGtmStrategyHTML(content) {
  const { cover, entries, docId } = content;

  const coverPage = pageShell(`
    <div class="header-band">
      <div>
        <div class="brand">${esc(cover.company)}</div>
      </div>
      <div class="meta">
        <div class="badge">${esc(cover.classification)}</div>
      </div>
    </div>
    <div class="cover-title-block">
      <div class="cover-kicker">${esc(cover.kicker)}</div>
      <h1>${esc(cover.title)}</h1>
      <p class="subtitle">${esc(cover.subtitle)}</p>
      <div class="doc-line">${esc(cover.docLine)}</div>
    </div>
  `);

  const runningHeader = `
    <div class="running-header">
      <div class="doc-title">${esc(cover.company)}</div>
      <div>${esc(docId)}</div>
    </div>`;
  const runningFooter = `
    <div class="running-footer">
      <div>${esc(cover.company)}</div>
      <div>${esc(docId)}</div>
    </div>`;

  // Derived directly from `entries` — a Table of Contents that can never
  // drift out of sync with the actual section numbers, since it isn't a
  // separately hand-maintained list.
  const tocGroups = [];
  let currentGroup = null;
  for (const entry of entries) {
    if (entry.type === "divider") {
      currentGroup = { title: entry.title, items: [] };
      tocGroups.push(currentGroup);
    } else if (currentGroup) {
      currentGroup.items.push({ number: entry.number, title: entry.title });
    }
  }
  const tocPage = pageShell(`
    ${runningHeader}
    <div class="section-body">
      <div class="section-number">CONTENTS</div>
      <h1 class="section-title">Table of Contents</h1>
      ${tocGroups
        .map(
          (group) => `
        <div class="subsection">
          <h3 class="subsection-heading">${esc(group.title)}</h3>
          <ul class="bullets">
            ${group.items.map((item) => `<li>${esc(item.number)} — ${esc(item.title)}</li>`).join("")}
          </ul>
        </div>`
        )
        .join("\n")}
    </div>
    ${runningFooter}
  `);

  const entryPages = entries
    .map((entry) => {
      if (entry.type === "divider") {
        return pageShell(`${runningHeader}${renderBlock(entry)}${runningFooter}`);
      }
      const blocksHtml = entry.blocks.map(renderBlock).join("\n");
      return pageShell(`
        ${runningHeader}
        <div class="section-body">
          <div class="section-number">SECTION ${esc(entry.number)} — PART ${esc(entry.part)}</div>
          <h1 class="section-title">${esc(entry.title)}</h1>
          ${blocksHtml}
        </div>
        ${runningFooter}
      `);
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"/></head><body>${coverPage}${tocPage}${entryPages}</body></html>`;
}
