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
      // "short": every item is a few words, so layouts that want to can set it in columns.
      const short = block.items.length >= 4 && block.items.every((i) => String(i).length <= 45) ? " short" : "";
      return `${lead}<ul class="bullets${short}">${items}</ul>`;
    }

    // Items are either { heading, body } or plain strings (a plain string used to render as an empty
    // "<strong></strong> " line: the onboarding guide's steps all came out blank, 16 Nov 2026).
    case "numbered": {
      const items = block.items
        .map((i) => (typeof i === "string" ? `<li>${escMultiline(i)}</li>` : `<li><strong>${esc(i.heading)}</strong> ${escMultiline(i.body)}</li>`))
        .join("\n");
      return `<ol class="numbered">${items}</ol>`;
    }

    // Customer-guide step cards: a numbered circle per step, an optional bold label, then the text.
    case "steps": {
      const items = block.items
        .map((i, n) => {
          const label = typeof i === "string" ? "" : `<strong>${esc(i.heading)}</strong> `;
          const text = typeof i === "string" ? i : i.body;
          return `<li class="step"><span class="step-num">${n + 1}</span><div class="step-text">${label}${escMultiline(text)}</div></li>`;
        })
        .join("\n");
      return `${block.lead ? `<p class="lead">${escMultiline(block.lead)}</p>` : ""}<ol class="steps">${items}</ol>`;
    }

    // A row of headline figures: [{ value, label }].
    case "stats":
      return `<div class="stats">${block.items.map((s) => `<div class="stat"><div class="stat-value">${esc(s.value)}</div><div class="stat-label">${escMultiline(s.label)}</div></div>`).join("")}</div>`;

    case "heading":
      return `<h2 class="block-heading">${esc(block.text)}</h2>`;

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

    case "code": {
      const label = block.label ? `<div class="code-label">${esc(block.label)}</div>` : "";
      return `<div class="code-block">${label}<pre><code>${esc(block.text)}</code></pre></div>`;
    }

    // A labeled sub-block within a section (e.g. Section 05's "Problem 1-6",
    // Section 13's "Principle One-Five") — GTM's dominant structural pattern.
    case "subsection": {
      const paraHtml = block.body ? `<p class="lead">${escMultiline(block.body)}</p>` : "";
      const shortList = block.bullets && block.bullets.length >= 4 && block.bullets.every((b) => String(b).length <= 45) ? " short" : "";
      const bulletsHtml = block.bullets
        ? `<ul class="bullets${shortList}">${block.bullets.map((b) => `<li>${escMultiline(b)}</li>`).join("")}</ul>`
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

// Customer guides: a cover, then sections that FLOW one after another (no half-empty page per short
// section). Page numbers and the running line come from the PDF header/footer (see generate-one.mjs).
export function buildCustomerGuideHTML(content) {
  const { cover, sections } = content;
  const contents = sections.map((s) => `<li><span class="toc-num">${esc(s.number)}</span>${esc(s.title)}</li>`).join("");
  const coverPage = `
    <div class="page guide-cover">
      <div class="header-band">
        <div><div class="brand">${esc(cover.company)}</div></div>
        <div class="meta"><div class="badge">${esc(cover.classification)}</div></div>
      </div>
      <div class="cover-title-block">
        <div class="cover-kicker">${esc(cover.kicker)}</div>
        <h1>${esc(cover.title)}</h1>
        <p class="subtitle">${esc(cover.subtitle)}</p>
        ${cover.stats ? renderBlock({ type: "stats", items: cover.stats }) : ""}
        <div class="guide-toc"><div class="guide-toc-title">In this guide</div><ol>${contents}</ol></div>
        <div class="doc-line">${esc(cover.docLine)}</div>
      </div>
    </div>`;
  const body = sections
    // The title is kept on the same page as the section's first block, so it is never stranded at a page bottom.
    // A short intro line stays with the block it introduces too.
    .map((s) => {
      const kept = s.blocks[0]?.type === "lead" && s.blocks.length > 1 ? 2 : 1;
      return `
      <section class="guide-section">
        <div class="keep-together">
          <div class="section-number">SECTION ${esc(s.number)}</div>
          <h1 class="section-title">${esc(s.title)}</h1>
          ${s.blocks.slice(0, kept).map(renderBlock).join("\n")}
        </div>
        ${s.blocks.slice(kept).map(renderBlock).join("\n")}
      </section>`;
    })
    .join("\n");
  // Content pages get real margins (room for the page-number header/footer); the cover stays full-bleed.
  // CSS page-margin boxes (Chrome 131+), so the cover can switch them off.
  const box = "font-family: Segoe UI, Arial, sans-serif; font-size: 7.5pt; color: #5b6270; letter-spacing: 0.06em;";
  const pageRules = `<style>
    @page { size: A4; margin: 18mm 18mm 16mm;
      @top-left { content: "INAYA NETWORK"; ${box} font-weight: 700; color: #1f2430; }
      @top-right { content: "${esc(content.docId)}"; ${box} }
      @bottom-left { content: "inayanetwork.com"; ${box} }
      @bottom-right { content: "Page " counter(page) " of " counter(pages); ${box} } }
    @page :first { margin: 0; @top-left { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
  </style>`;
  return `<!doctype html><html><head><meta charset="utf-8"/></head><body class="guide">${pageRules}${coverPage}<div class="guide-body">${body}</div></body></html>`;
}

// Long strategy documents (the GTM Strategy): a full-bleed navy cover with headline figures, an
// optional "at a glance" page, a contents page, full-bleed Part dividers, and every section starting
// on a new page with real page margins, a running line and page numbers (CSS page-margin boxes).
export function buildStrategyBookHTML(content) {
  const { cover, entries, docId, glance } = content;
  const box = "font-family: Segoe UI, Arial, sans-serif; font-size: 7.5pt; color: #5b6270; letter-spacing: 0.06em;";
  const pageRules = `<style>
    @page { size: A4; margin: 20mm 18mm 18mm;
      @top-left { content: "INAYA NETWORK  ·  GO-TO-MARKET STRATEGY"; ${box} font-weight: 700; color: #1f2430; }
      @top-right { content: "${esc(docId)}"; ${box} }
      @bottom-left { content: "Confidential  ·  inayanetwork.com"; ${box} }
      @bottom-right { content: counter(page) " / " counter(pages); ${box} } }
    @page bleed { margin: 0; @top-left { content: none; } @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
  </style>`;

  const coverHtml = `
    <div class="bk-bleed bk-cover">
      <div class="bk-cover-top"><span class="bk-brand">${esc(cover.company)}</span><span class="bk-badge">${esc(cover.classification)}</span></div>
      <div class="bk-cover-main">
        <div class="bk-kicker">${esc(cover.kicker)}</div>
        <h1 class="bk-title">${esc(cover.title)}</h1>
        <p class="bk-subtitle">${escMultiline(cover.subtitle)}</p>
      </div>
      ${cover.stats ? `<div class="bk-cover-stats">${cover.stats.map((s) => `<div><div class="bk-cs-value">${esc(s.value)}</div><div class="bk-cs-label">${escMultiline(s.label)}</div></div>`).join("")}</div>` : ""}
      <div class="bk-cover-foot">${esc(cover.docLine)}</div>
    </div>`;

  const glanceHtml = glance
    ? `<section class="bk-section bk-glance">
        <div class="section-number">AT A GLANCE</div>
        <h1 class="section-title">${esc(glance.title)}</h1>
        ${glance.blocks.map(renderBlock).join("\n")}
      </section>`
    : "";

  // Contents derived from entries, so it can never drift from the real numbering.
  const groups = [];
  for (const e of entries) {
    if (e.type === "divider") groups.push({ kicker: e.kicker, title: e.title, items: [] });
    else if (groups.length) groups[groups.length - 1].items.push(e);
  }
  const tocHtml = `
    <section class="bk-section bk-toc">
      <div class="section-number">CONTENTS</div>
      <h1 class="section-title">Table of Contents</h1>
      ${groups.map((g) => `
        <div class="bk-toc-group">
          <div class="bk-toc-part">${esc(g.kicker)}</div>
          <ol>${g.items.map((i) => `<li><span class="bk-toc-num">${esc(i.number)}</span>${esc(i.title)}</li>`).join("")}</ol>
        </div>`).join("")}
    </section>`;

  const body = entries
    .map((e) => {
      if (e.type === "divider") {
        const list = groups.find((g) => g.title === e.title)?.items || [];
        return `
          <div class="bk-bleed bk-divider">
            <div class="bk-kicker">${esc(e.kicker)}</div>
            <h1 class="bk-divider-title">${esc(e.title)}</h1>
            <ol class="bk-divider-list">${list.map((i) => `<li><span>${esc(i.number)}</span>${esc(i.title)}</li>`).join("")}</ol>
          </div>`;
      }
      const kept = e.blocks[0]?.type === "lead" && e.blocks.length > 1 ? 2 : 1;
      return `
        <section class="bk-section">
          <div class="keep-together">
            <div class="bk-sec-head"><span class="bk-sec-num">${esc(e.number)}</span><span class="bk-sec-part">PART ${esc(e.part)}</span></div>
            <h1 class="section-title">${esc(e.title)}</h1>
            ${e.blocks.slice(0, kept).map(renderBlock).join("\n")}
          </div>
          ${e.blocks.slice(kept).map(renderBlock).join("\n")}
        </section>`;
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"/></head><body class="book">${pageRules}${coverHtml}${glanceHtml}${tocHtml}${body}</body></html>`;
}

export function buildOperatorManifestoHTML(content) {
  const { cover, intro, sections, docId } = content;

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
    </div>
    <div class="cover-meta-grid">
      ${cover.metaItems
        .map((item) => `<div><span class="cover-meta-label">${esc(item.label)}</span> ${esc(item.value)}</div>`)
        .join("\n")}
    </div>
  `);

  const introPage = pageShell(`
    <div class="divider">
      <div class="divider-kicker">${esc(intro.kicker)}</div>
      <h1 class="divider-title">${esc(intro.title)}</h1>
      <p class="divider-subtitle">${escMultiline(intro.subtitle)}</p>
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

  const sectionPages = sections
    .map((section) => {
      const blocksHtml = section.blocks.map(renderBlock).join("\n");
      return pageShell(`
        ${runningHeader}
        <div class="section-body">
          <div class="section-number">SECTION ${esc(section.number)}</div>
          <h1 class="section-title">${esc(section.title)}</h1>
          ${blocksHtml}
        </div>
        ${runningFooter}
      `);
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"/></head><body>${coverPage}${introPage}${sectionPages}</body></html>`;
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
