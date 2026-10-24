// src/components/business/erp/ErpPanel.js
//
// ERP mode's boxed panel: a coloured title bar over a white body, the way a
// classic desktop ERP lays out its dashboards. `tone` picks the title bar
// colour from the theme (blue, red, green, amber, purple, graphite).

export default function ErpPanel({ title, tone = "blue", action, onAction, children, className = "", bodyClassName = "" }) {
  return (
    <section className={`erp-box ${className}`} aria-label={title}>
      <header className="erp-box-head" data-tone={tone}>
        <h2 className="erp-box-title">{title}</h2>
        {action && <button type="button" className="erp-box-action" onClick={onAction}>{action}</button>}
      </header>
      <div className={`erp-box-body ${bodyClassName}`}>{children}</div>
    </section>
  );
}
