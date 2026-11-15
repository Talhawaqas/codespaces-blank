"use client";

// src/components/business/hospitality/Back.js
//
// Back-of-house screens of Hospitality OS: menu and recipes, ingredient stock (wastage, counts, reorder,
// deliveries) and daily operations (roster, checklists, incidents). Inventory and Procurement remain the
// authoritative modules; these screens link to them.

import { useState } from "react";
import { api, H, send, panel, row, input, primary, ghost, danger, muted, h3, label, today, addDays, money, useLoad, useAction, Msg, Field, State, Confirm } from "./shared";

const Sub = ({ tabs, value, onChange }) => (
  <div className="flex gap-1 flex-wrap" role="tablist">
    {tabs.map(([k, t]) => <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)} className={`px-3 py-1.5 text-[11px] font-bold uppercase rounded-lg border ${value === k ? "border-[#00f2fe]/40 text-[#00f2fe]" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{t}</button>)}
  </div>
);

// ================= Menu & recipes =================
export function MenuTab({ orgId, locationId, location }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "menu", { locationId })), [orgId, locationId]);
  const [sugg] = useLoad(() => api(H(orgId, "menu/suggestions")), [orgId]);
  const [edit, setEdit] = useState(null);
  const [recipeFor, setRecipeFor] = useState(null);
  const { busy, msg, run } = useAction();
  const can = data?.can || {};
  const currency = location?.currency || "USD";
  const act = (fn, ok) => run(fn, ok).then((x) => x && reload());
  return (
    <div className="space-y-4">
      <Msg msg={msg} />
      {sugg?.suggestions?.length > 0 && (
        <div className={`${panel} border-amber-400/30`}>
          <h3 className={h3}>Items you may want to switch off</h3>
          <p className={`${muted} mb-2`}>{sugg.note}</p>
          <div className="space-y-2">{sugg.suggestions.map((s) => (
            <div key={s.itemId} className={row}>
              <span className="text-sm text-[var(--inaya-text-primary)]">{s.name}: {s.ingredients.map((i) => `${i.name} (${i.onHand} ${i.unit}, ${i.reason.toLowerCase()})`).join("; ")}</span>
              {can.edit && <Confirm text={`Mark "${s.name}" unavailable? Guests and staff will see it as off the menu.`} disabled={busy} onYes={() => act(() => send(orgId, `menu/items/${s.itemId}/availability`, "POST", { available: false, reason: "Ingredient shortage" }), "Marked unavailable.")}>Mark unavailable</Confirm>}
            </div>
          ))}</div>
        </div>
      )}
      {can.publish && (
        <div className={`${panel} flex gap-3 flex-wrap items-end`}>
          <form className="flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target); act(() => send(orgId, "menu/menus", "POST", { name: fd.get("name"), status: "active" }), "Menu added.").then(() => e.target.reset()); }}>
            <Field label="New menu"><input name="name" className={input} placeholder="Dinner" required /></Field><button className={ghost} disabled={busy}>Add menu</button>
          </form>
          {data?.menus?.length > 0 && (
            <form className="flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target); act(() => send(orgId, "menu/categories", "POST", { menuId: fd.get("menuId"), name: fd.get("name") }), "Category added.").then(() => e.target.reset()); }}>
              <Field label="Menu"><select name="menuId" className={input}>{data.menus.map((m) => <option key={m.id} value={m.id}>{m.name} (v{m.version})</option>)}</select></Field>
              <Field label="New category"><input name="name" className={input} placeholder="Starters" required /></Field><button className={ghost} disabled={busy}>Add category</button>
            </form>
          )}
        </div>
      )}
      {can.edit && data?.categories?.length > 0 && <button className={primary} onClick={() => setEdit({})}>New item</button>}
      {edit && <ItemForm orgId={orgId} data={data} item={edit} currency={currency} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      <State loading={loading} error={error} empty={data && !data.categories.length} emptyText={can.publish ? "Add a menu and a category to start your catalogue." : "No menu has been set up yet."}>
        {(data?.categories || []).map((c) => {
          const items = data.items.filter((i) => i.categoryId === c.id);
          return (
            <div key={c.id} className={panel}>
              <h3 className={h3}>{data.menus.find((m) => m.id === c.menuId)?.name} · {c.name}</h3>
              {!items.length ? <p className={muted}>No items in this category.</p> : (
                <div className="space-y-2">{items.map((i) => (
                  <div key={i.id} className={row}>
                    <span className="text-sm text-[var(--inaya-text-primary)]">
                      <strong>{i.name}</strong> · {money(i.priceMinor, i.currency)} · <span className={i.status === "active" ? "text-emerald-400" : i.status === "unavailable" ? "text-red-400" : "text-amber-400"}>{label(i.status)}</span>
                      <span className={`${muted} block`}>{i.allergens.length ? `Contains: ${i.allergens.map(label).join(", ")}` : "No allergens listed"}{i.dietary.length ? ` · ${i.dietary.map(label).join(", ")}` : ""}{i.allergenReview ? "" : " · allergen information not reviewed"}{i.recipe ? ` · recipe v${i.recipe.version}` : ""}{i.manualUnavailable?.reason ? ` · off: ${i.manualUnavailable.reason}` : ""}</span>
                    </span>
                    <span className="flex gap-2 flex-wrap">
                      <button className={ghost} onClick={() => setRecipeFor(i)}>Recipe</button>
                      {can.edit && <button className={ghost} onClick={() => setEdit(i)}>Edit</button>}
                      {can.edit && i.status === "active" && <Confirm text={`Mark "${i.name}" unavailable?`} disabled={busy} onYes={() => act(() => send(orgId, `menu/items/${i.id}/availability`, "POST", { available: false, reason: window.prompt("Reason (optional):") || "" }), "Marked unavailable.")}>Switch off</Confirm>}
                      {can.edit && i.status === "unavailable" && <button className={ghost} disabled={busy} onClick={() => act(() => send(orgId, `menu/items/${i.id}/availability`, "POST", { available: true }), "Available again.")}>Switch on</button>}
                    </span>
                  </div>
                ))}</div>
              )}
            </div>
          );
        })}
      </State>
      {data?.disclaimer && <p className={muted}>{data.disclaimer}</p>}
      {recipeFor && <RecipePanel orgId={orgId} item={recipeFor} canEdit={can.edit} onClose={() => { setRecipeFor(null); reload(); }} />}
    </div>
  );
}

function ItemForm({ orgId, data, item, currency, onClose, onSaved }) {
  const isNew = !item.id;
  const [f, setF] = useState({ name: item.name || "", description: item.description || "", categoryId: item.categoryId || data.categories[0]?.id, price: item.priceMinor !== undefined ? (item.priceMinor / 100).toString() : "", currency: item.currency || currency, status: item.status || "draft", allergens: item.allergens || [], dietary: item.dietary || [], modifiers: JSON.stringify(item.modifiers || [], null, 1) });
  const { busy, msg, run, setMsg } = useAction();
  const toggle = (k, v) => setF((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));
  const save = (e) => {
    e.preventDefault();
    let modifiers; try { modifiers = JSON.parse(f.modifiers || "[]"); } catch { setMsg({ ok: false, text: "Options must be valid: a list of groups, each with a name and options." }); return; }
    const body = { name: f.name, description: f.description, categoryId: f.categoryId, priceMinor: Math.round(Number(f.price) * 100), currency: f.currency, allergens: f.allergens, dietary: f.dietary, modifiers, ...(data.can.publish ? { status: f.status } : {}) };
    run(() => send(orgId, isNew ? "menu/items" : `menu/items/${item.id}`, isNew ? "POST" : "PATCH", body), "Saved.").then((x) => x && onSaved());
  };
  return (
    <form className={`${panel} space-y-3`} onSubmit={save}>
      <h3 className={h3}>{isNew ? "New menu item" : `Edit ${item.name}`}</h3>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Name"><input className={input} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Category"><select className={input} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>{data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label={`Price (${f.currency})`}><input className={input} type="number" min="0" step="0.01" required value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
        <Field label="Currency"><input className={input} maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
        <Field label="Description" className="sm:col-span-2 lg:col-span-3"><input className={input} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {data.can.publish && <Field label="Status"><select className={input} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{["draft", "active", "unavailable", "archived"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>}
      </div>
      <fieldset><legend className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)] mb-1">Allergens it contains</legend><div className="flex gap-2 flex-wrap">{data.allergens.map((a) => <label key={a} className="flex items-center gap-1 text-[12px] text-[var(--inaya-text-muted)]"><input type="checkbox" checked={f.allergens.includes(a)} onChange={() => toggle("allergens", a)} />{label(a)}</label>)}</div></fieldset>
      <fieldset><legend className="text-[11px] uppercase font-bold text-[var(--inaya-text-muted)] mb-1">Dietary labels</legend><div className="flex gap-2 flex-wrap">{data.dietary.map((a) => <label key={a} className="flex items-center gap-1 text-[12px] text-[var(--inaya-text-muted)]"><input type="checkbox" checked={f.dietary.includes(a)} onChange={() => toggle("dietary", a)} />{label(a)}</label>)}</div></fieldset>
      <p className={muted}>{data.can.publish ? "Saving as a manager records you as having reviewed the allergen and dietary information." : "A manager reviews allergen information and publishes the item."}</p>
      <details><summary className={`${muted} cursor-pointer`}>Options (sizes, add-ons)</summary><textarea className={`${input} w-full h-28 font-mono mt-2`} value={f.modifiers} onChange={(e) => setF({ ...f, modifiers: e.target.value })} aria-label="Options" /><p className={muted}>Example: [{`{"name":"Size","required":true,"options":[{"name":"Large","priceDeltaMinor":20000}]}`}]</p></details>
      <Msg msg={msg} />
      <div className="flex gap-2"><button className={primary} disabled={busy}>Save</button><button type="button" className={ghost} onClick={onClose}>Cancel</button></div>
    </form>
  );
}

function RecipePanel({ orgId, item, canEdit, onClose }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, `menu/items/${item.id}/recipe`)), [orgId, item.id]);
  const [ing] = useLoad(() => (canEdit ? api(H(orgId, "menu/ingredients")) : Promise.resolve({ ingredients: [] })), [orgId, canEdit]);
  const [rows, setRows] = useState(null);
  const [yieldServings, setYield] = useState(1);
  const { busy, msg, run } = useAction();
  const start = () => { setRows((data?.item?.recipe?.ingredients || []).map((i) => ({ productId: i.productId, quantity: i.quantity, unit: i.unit, substitution: i.substitution || "" }))); setYield(data?.item?.recipe?.yieldServings || 1); };
  const cost = data?.cost;
  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex justify-end" role="dialog" aria-modal="true" aria-label="Recipe" onClick={onClose}>
      <div className="w-full max-w-xl h-full overflow-y-auto bg-[var(--inaya-surface)] border-l border-white/10 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center"><h3 className="text-[var(--inaya-text-primary)] font-semibold">Recipe: {item.name}</h3><button className={ghost} onClick={onClose}>Close</button></div>
        <State loading={loading} error={error}>
          {data && !rows && (
            <>
              {!data.ingredients.length ? <p className={muted}>No recipe yet.</p> : (
                <>
                  <p className={muted}>Makes {data.item.recipe.yieldServings} serving{data.item.recipe.yieldServings === 1 ? "" : "s"} · version {data.item.recipe.version}{data.servingsPossible !== null && Number.isFinite(data.servingsPossible) ? ` · stock covers about ${data.servingsPossible} servings` : ""}</p>
                  <div className="space-y-2">{data.ingredients.map((i) => <div key={i.productId} className={row}><span className="text-sm text-[var(--inaya-text-primary)]">{i.name}: {i.quantity} {i.unit}</span><span className={muted}>{i.onHand} {i.stockUnit} in stock{i.substitution ? ` · can substitute: ${i.substitution}` : ""}</span></div>)}</div>
                  <p className={muted}>{cost.status === "estimate" ? `Estimated cost per serving: ${cost.costPerServing.toFixed(2)} (an estimate from the latest purchase prices).` : cost.status === "insufficient_data" ? `Cost can't be estimated: ${cost.missing} ingredient${cost.missing === 1 ? " has" : "s have"} no purchase price yet.` : ""}</p>
                </>
              )}
              {canEdit && <button className={primary} onClick={start}>{data.ingredients.length ? "Edit recipe" : "Add recipe"}</button>}
              {data.history?.length > 0 && <details><summary className={`${muted} cursor-pointer`}>Earlier versions</summary>{data.history.map((h) => <p key={h.version} className={muted}>v{h.version}: {h.ingredients} ingredients, replaced {new Date(h.replacedAt).toLocaleDateString()} by {h.replacedByEmail}</p>)}</details>}
            </>
          )}
          {rows && (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(() => send(orgId, `menu/items/${item.id}/recipe`, "PUT", { recipe: rows.length ? { yieldServings: Number(yieldServings), ingredients: rows.map((r) => ({ ...r, quantity: Number(r.quantity) })) } : null }), "Recipe saved.").then((x) => { if (x) { setRows(null); reload(); } }); }}>
              <Field label="Servings this recipe makes"><input className={`${input} w-28`} type="number" min="0.01" step="any" value={yieldServings} onChange={(e) => setYield(e.target.value)} /></Field>
              {rows.map((r, n) => (
                <div key={n} className="grid grid-cols-12 gap-2 items-end">
                  <Field label="Ingredient" className="col-span-5"><select className={input} required value={r.productId} onChange={(e) => setRows(rows.map((x, i) => (i === n ? { ...x, productId: e.target.value, unit: ing?.ingredients.find((p) => p.productId === e.target.value)?.unit || x.unit } : x)))}><option value="">Choose…</option>{(ing?.ingredients || []).map((p) => <option key={p.productId} value={p.productId}>{p.name} ({p.unit})</option>)}</select></Field>
                  <Field label="Qty" className="col-span-2"><input className={input} type="number" min="0" step="any" required value={r.quantity} onChange={(e) => setRows(rows.map((x, i) => (i === n ? { ...x, quantity: e.target.value } : x)))} /></Field>
                  <Field label="Unit" className="col-span-2"><input className={input} value={r.unit} onChange={(e) => setRows(rows.map((x, i) => (i === n ? { ...x, unit: e.target.value } : x)))} /></Field>
                  <Field label="Substitute" className="col-span-2"><input className={input} value={r.substitution} onChange={(e) => setRows(rows.map((x, i) => (i === n ? { ...x, substitution: e.target.value } : x)))} /></Field>
                  <button type="button" className={danger} aria-label="Remove ingredient" onClick={() => setRows(rows.filter((_, i) => i !== n))}>×</button>
                </div>
              ))}
              <button type="button" className={ghost} onClick={() => setRows([...rows, { productId: "", quantity: "", unit: "", substitution: "" }])}>Add ingredient</button>
              <p className={muted}>Ingredients come from Inventory. Units convert between weights (g, kg) and between volumes (ml, l); anything else must match the unit the item is stocked in.</p>
              <Msg msg={msg} />
              <div className="flex gap-2"><button className={primary} disabled={busy}>Save recipe</button><button type="button" className={ghost} onClick={() => setRows(null)}>Cancel</button></div>
            </form>
          )}
        </State>
      </div>
    </div>
  );
}

// ================= Stock =================
export function StockTab({ orgId, locationId, can, options }) {
  const [sub, setSub] = useState("overview");
  return (
    <div className="space-y-4">
      <Sub value={sub} onChange={setSub} tabs={[["overview", "Stock & reorder"], ["wastage", "Wastage"], ["counts", "Stock counts"], ["receiving", "Deliveries"]]} />
      <p className={muted}>Products, transfers and purchase orders are managed in <a className="underline" href="/business?view=inventory">Inventory</a> and <a className="underline" href="/business?view=procurement">Procurement</a>.</p>
      {sub === "overview" && <StockOverview orgId={orgId} locationId={locationId} can={can} options={options} />}
      {sub === "wastage" && <Wastage orgId={orgId} locationId={locationId} can={can} />}
      {sub === "counts" && <Counts orgId={orgId} locationId={locationId} can={can} />}
      {sub === "receiving" && <Receiving orgId={orgId} locationId={locationId} can={can} />}
    </div>
  );
}

function StockOverview({ orgId, locationId, can, options }) {
  const [lowOnly, setLowOnly] = useState(false);
  const [q, setQ] = useState("");
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "stock", { locationId, q, lowOnly: lowOnly ? 1 : "" })), [orgId, locationId, q, lowOnly]);
  const [pos] = useLoad(() => api(H(orgId, "stock/purchase-orders")).catch(() => ({ suppliers: [] })), [orgId]);
  const [pref, setPref] = useState(null);
  const { busy, msg, run } = useAction();
  return (
    <div className={`${panel} space-y-3`}>
      <div className="flex gap-3 flex-wrap items-end"><Field label="Search"><input className={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or code" /></Field><label className="flex items-center gap-2 text-[12px] text-[var(--inaya-text-muted)]"><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low stock only</label></div>
      <Msg msg={msg} />
      <State loading={loading} error={error} empty={data && !data.products.length} emptyText="No ingredients found. Add products in Inventory.">
        <div className="space-y-2">{(data?.products || []).map((p) => (
          <div key={p.productId} className={row}>
            <span className="text-sm text-[var(--inaya-text-primary)]">{p.name} <span className={muted}>({p.sku})</span><span className={`${muted} block`}>In stock: {p.onHand} {p.unit}{p.reorderThreshold ? ` · reorder at ${p.reorderThreshold}` : ""}{p.nextExpiry ? ` · earliest use-by ${String(p.nextExpiry).slice(0, 10)}` : ""}{p.supplier?.leadTimeDays !== null && p.supplier?.leadTimeDays !== undefined ? ` · lead time ${p.supplier.leadTimeDays} days` : ""}</span></span>
            <span className="flex gap-2 items-center flex-wrap">
              {p.low && <span className="text-amber-400 text-[12px]">Low · suggested order {p.suggestedReorderQuantity}</span>}
              {p.openRequest ? <span className={muted}>Purchase request {label(p.openRequest.status).toLowerCase()}</span> : p.low && can.reorder && <button className={primary} disabled={busy} onClick={() => run(() => send(orgId, "stock/reorder", "POST", { locationId, productId: p.productId }), (r) => r.note).then((x) => x && reload())}>Draft purchase request</button>}
              {can.reorder && <button className={ghost} onClick={() => setPref(pref?.productId === p.productId ? null : { productId: p.productId, supplierId: p.supplier?.supplierId || "", category: p.supplier?.category || "", leadTimeDays: p.supplier?.leadTimeDays ?? "", minOrderQuantity: p.supplier?.minOrderQuantity ?? "", deliveryDays: p.supplier?.deliveryDays || "" })}>Supplier</button>}
            </span>
            {pref?.productId === p.productId && (
              <form className="w-full flex gap-2 flex-wrap items-end" onSubmit={(e) => { e.preventDefault(); run(() => send(orgId, "stock/suppliers", "PUT", pref), "Supplier details saved.").then((x) => { if (x) { setPref(null); reload(); } }); }}>
                <Field label="Preferred supplier"><select className={input} value={pref.supplierId} onChange={(e) => setPref({ ...pref, supplierId: e.target.value })}><option value="">None</option>{(pos?.suppliers || []).map((s) => <option key={s.supplierId} value={s.supplierId}>{s.name}</option>)}</select></Field>
                <Field label="Category"><select className={input} value={pref.category} onChange={(e) => setPref({ ...pref, category: e.target.value })}><option value="">None</option>{(options?.supplierCategories || []).map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
                <Field label="Lead time (days)"><input className={`${input} w-24`} type="number" min="0" value={pref.leadTimeDays} onChange={(e) => setPref({ ...pref, leadTimeDays: e.target.value })} /></Field>
                <Field label="Minimum order"><input className={`${input} w-24`} type="number" min="0" step="any" value={pref.minOrderQuantity} onChange={(e) => setPref({ ...pref, minOrderQuantity: e.target.value })} /></Field>
                <Field label="Delivery days"><input className={input} value={pref.deliveryDays} onChange={(e) => setPref({ ...pref, deliveryDays: e.target.value })} placeholder="Mon, Thu" /></Field>
                <button className={ghost} disabled={busy}>Save</button>
              </form>
            )}
          </div>
        ))}</div>
      </State>
      <p className={muted}>Stock figures are actual quantities at this location. Suggested orders are suggestions; a purchase request still has to be submitted and approved in Procurement.</p>
    </div>
  );
}

function Wastage({ orgId, locationId, can }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "stock/wastage", { locationId })), [orgId, locationId]);
  const [stock] = useLoad(() => api(H(orgId, "stock", { locationId })).catch(() => ({ products: [] })), [orgId, locationId]);
  const { busy, msg, run } = useAction();
  return (
    <div className="space-y-4">
      {can.stockWrite && (
        <form className={`${panel} flex gap-3 flex-wrap items-end`} onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target); run(() => send(orgId, "stock/wastage", "POST", { locationId, productId: fd.get("productId"), quantity: Number(fd.get("quantity")), reason: fd.get("reason"), note: fd.get("note") }), (r) => (r.stockReduced ? "Wastage recorded and stock reduced." : "Recorded. Stock will be reduced once a manager approves it.")).then((x) => { if (x) { e.target.reset(); reload(); } }); }}>
          <Field label="Ingredient"><select name="productId" className={input} required><option value="">Choose…</option>{(stock?.products || []).map((p) => <option key={p.productId} value={p.productId}>{p.name} ({p.onHand} {p.unit})</option>)}</select></Field>
          <Field label="Quantity"><input name="quantity" className={`${input} w-24`} type="number" min="0" step="any" required /></Field>
          <Field label="Reason"><select name="reason" className={input}>{(data?.reasons || []).map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
          <Field label="Note"><input name="note" className={input} /></Field>
          <button className={primary} disabled={busy}>Record wastage</button>
        </form>
      )}
      <Msg msg={msg} />
      {can.manage && data && (
        <form className={`${panel} flex gap-3 items-end flex-wrap`} onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target); run(() => send(orgId, "stock/settings", "PUT", { wastageApprovalQuantity: fd.get("q") }), "Rule saved.").then((x) => x && reload()); }}>
          <Field label="Wastage at or above this quantity needs approval" hint="Leave empty for no approval step."><input name="q" className={`${input} w-32`} type="number" min="0" step="any" defaultValue={data.settings.wastageApprovalQuantity ?? ""} /></Field><button className={ghost} disabled={busy}>Save rule</button>
        </form>
      )}
      <div className={panel}>
        <h3 className={h3}>Wastage records</h3>
        <State loading={loading} error={error} empty={!data?.wastage?.length} emptyText="No wastage recorded.">
          <div className="space-y-2">{(data?.wastage || []).map((w) => (
            <div key={w.id} className={row}>
              <span className="text-sm text-[var(--inaya-text-primary)]">{w.ref} · {w.productName}: {w.quantity} {w.unit} · {label(w.reason)}<span className={`${muted} block`}>{new Date(w.at).toLocaleString()} · {w.recordedByEmail}{w.note ? ` · ${w.note}` : ""}</span></span>
              <span className="flex gap-2 items-center"><span className={w.status === "PENDING_APPROVAL" ? "text-amber-400 text-[12px]" : muted}>{label(w.status)}</span>
                {w.status === "PENDING_APPROVAL" && can.stockApprove && <><Confirm text="Approve this wastage and reduce stock?" className={primary} disabled={busy} onYes={() => run(() => send(orgId, `stock/wastage/${w.id}/decide`, "POST", { approve: true }), "Approved and stock reduced.").then(reload)}>Approve</Confirm><button className={danger} disabled={busy} onClick={() => run(() => send(orgId, `stock/wastage/${w.id}/decide`, "POST", { approve: false }), "Rejected. Stock was not changed.").then(reload)}>Reject</button></>}
              </span>
            </div>
          ))}</div>
        </State>
      </div>
    </div>
  );
}

function Counts({ orgId, locationId, can }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "stock/counts", { locationId })), [orgId, locationId]);
  const [stock] = useLoad(() => api(H(orgId, "stock", { locationId })).catch(() => ({ products: [] })), [orgId, locationId]);
  const [counted, setCounted] = useState({});
  const { busy, msg, run } = useAction();
  const lines = Object.entries(counted).filter(([, v]) => v !== "").map(([productId, v]) => ({ productId, counted: Number(v) }));
  return (
    <div className="space-y-4">
      {can.stockWrite && (
        <div className={`${panel} space-y-3`}>
          <h3 className={h3}>New count</h3>
          <p className={muted}>Enter what you counted. Leave a line empty to skip it. Small differences are applied straight away; large ones wait for a manager.</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">{(stock?.products || []).map((p) => <label key={p.productId} className="flex items-center justify-between gap-2 text-[12px] text-[var(--inaya-text-primary)] bg-black/20 border border-white/5 rounded-lg px-3 py-2"><span>{p.name} <span className={muted}>(system {p.onHand} {p.unit})</span></span><input className={`${input} w-24`} type="number" min="0" step="any" aria-label={`Counted ${p.name}`} value={counted[p.productId] ?? ""} onChange={(e) => setCounted({ ...counted, [p.productId]: e.target.value })} /></label>)}</div>
          <Msg msg={msg} />
          <button className={primary} disabled={busy || !lines.length} onClick={() => run(() => send(orgId, "stock/counts", "POST", { locationId, lines }), (r) => `Count ${r.count.ref}: ${label(r.count.status).toLowerCase()}.`).then((x) => { if (x) { setCounted({}); reload(); } })}>Submit count ({lines.length} lines)</button>
        </div>
      )}
      <div className={panel}>
        <h3 className={h3}>Recent counts</h3>
        <State loading={loading} error={error} empty={!data?.counts?.length} emptyText="No counts yet.">
          <div className="space-y-2">{(data?.counts || []).map((c) => (
            <div key={c.id} className={row}>
              <span className="text-sm text-[var(--inaya-text-primary)]">{c.ref} · {c.date} · {c.lines.filter((l) => l.difference !== 0).length} of {c.lines.length} lines differ<span className={`${muted} block`}>{c.lines.filter((l) => l.difference !== 0).slice(0, 4).map((l) => `${l.name}: ${l.system} → ${l.counted}`).join("; ")}</span></span>
              <span className="flex gap-2 items-center"><span className={c.status === "PENDING_APPROVAL" ? "text-amber-400 text-[12px]" : muted}>{label(c.status)}</span>
                {c.status === "PENDING_APPROVAL" && can.stockApprove && <><Confirm text="Apply this count? Stock quantities will change to the counted figures." className={primary} disabled={busy} onYes={() => run(() => send(orgId, `stock/counts/${c.id}/decide`, "POST", { approve: true }), "Count applied.").then(reload)}>Approve</Confirm><button className={danger} disabled={busy} onClick={() => run(() => send(orgId, `stock/counts/${c.id}/decide`, "POST", { approve: false }), "Count rejected. Stock was not changed.").then(reload)}>Reject</button></>}
              </span>
            </div>
          ))}</div>
        </State>
      </div>
    </div>
  );
}

function Receiving({ orgId, locationId, can }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "stock/receiving", { locationId })), [orgId, locationId]);
  const [pos] = useLoad(() => api(H(orgId, "stock/purchase-orders")), [orgId]);
  const [poId, setPoId] = useState("");
  const [checks, setChecks] = useState({});
  const [issues, setIssues] = useState([]);
  const { busy, msg, run } = useAction();
  const po = pos?.orders?.find((o) => o.id === poId);
  return (
    <div className="space-y-4">
      {can.stockWrite && (
        <div className={`${panel} space-y-3`}>
          <h3 className={h3}>Check a delivery</h3>
          <Field label="Purchase order"><select className={input} value={poId} onChange={(e) => { setPoId(e.target.value); setIssues([]); }}><option value="">Choose…</option>{(pos?.orders || []).map((o) => <option key={o.id} value={o.id}>{o.number} · {o.supplier} · {label(o.status)}</option>)}</select></Field>
          {po && (
            <>
              <div className="flex gap-3 flex-wrap">{(data?.checks || []).map((k) => <label key={k} className="flex items-center gap-1 text-[12px] text-[var(--inaya-text-muted)]">{label(k)}<select className={input} value={checks[k] ?? ""} onChange={(e) => setChecks({ ...checks, [k]: e.target.value === "" ? null : e.target.value === "yes" })} aria-label={label(k)}><option value="">Not checked</option><option value="yes">Yes</option><option value="no">No</option></select></label>)}</div>
              {issues.map((d, n) => (
                <div key={n} className="flex gap-2 flex-wrap items-end">
                  <Field label="Item"><select className={input} value={d.description} onChange={(e) => { const it = po.items.find((i) => i.description === e.target.value); setIssues(issues.map((x, i) => (i === n ? { ...x, description: e.target.value, productId: it?.productId || null, expectedQuantity: it?.quantity ?? x.expectedQuantity } : x))); }}><option value="">Choose…</option>{po.items.map((i) => <option key={i.description} value={i.description}>{i.description}</option>)}</select></Field>
                  {[["expectedQuantity", "Ordered"], ["receivedQuantity", "Received"], ["damagedQuantity", "Damaged"]].map(([k, t]) => <Field key={k} label={t}><input className={`${input} w-24`} type="number" min="0" step="any" value={d[k]} onChange={(e) => setIssues(issues.map((x, i) => (i === n ? { ...x, [k]: e.target.value } : x)))} /></Field>)}
                  <Field label="Note"><input className={input} value={d.note} onChange={(e) => setIssues(issues.map((x, i) => (i === n ? { ...x, note: e.target.value } : x)))} /></Field>
                </div>
              ))}
              <button type="button" className={ghost} onClick={() => setIssues([...issues, { description: "", expectedQuantity: 0, receivedQuantity: 0, damagedQuantity: 0, note: "" }])}>Add a discrepancy</button>
              <Msg msg={msg} />
              <button className={primary} disabled={busy} onClick={() => run(() => send(orgId, "stock/receiving", "POST", { locationId, purchaseOrderId: poId, checks, discrepancies: issues.map((d) => ({ ...d, expectedQuantity: Number(d.expectedQuantity), receivedQuantity: Number(d.receivedQuantity), damagedQuantity: Number(d.damagedQuantity) })) }), (r) => `${r.receiving.ref} saved. ${r.note}`).then((x) => { if (x) { setPoId(""); setChecks({}); setIssues([]); reload(); } })}>Save delivery check</button>
            </>
          )}
        </div>
      )}
      <div className={panel}>
        <h3 className={h3}>Delivery records</h3>
        <State loading={loading} error={error} empty={!data?.receiving?.length} emptyText="No deliveries checked yet.">
          <div className="space-y-2">{(data?.receiving || []).map((d) => (
            <div key={d.id} className={row}>
              <span className="text-sm text-[var(--inaya-text-primary)]">{d.ref} · {d.date} · {d.discrepancies.length} discrepanc{d.discrepancies.length === 1 ? "y" : "ies"}<span className={`${muted} block`}>{d.discrepancies.map((x) => `${x.description}: ordered ${x.expectedQuantity}, received ${x.receivedQuantity}${x.damagedQuantity ? `, damaged ${x.damagedQuantity}` : ""}`).join("; ")}{d.resolution ? ` · Resolved: ${d.resolution}` : ""}</span></span>
              <span className="flex gap-2 items-center"><span className={d.status === "OPEN" ? "text-amber-400 text-[12px]" : muted}>{label(d.status)}</span>{d.status === "OPEN" && can.reorder && <button className={ghost} disabled={busy} onClick={() => { const r = window.prompt("How was this resolved? (credit note, replacement, accepted as is)"); if (r) run(() => send(orgId, `stock/receiving/${d.id}/resolve`, "POST", { resolution: r }), "Resolved.").then(reload); }}>Resolve</button>}</span>
            </div>
          ))}</div>
        </State>
      </div>
    </div>
  );
}

// ================= Operations =================
export function OperationsTab({ orgId, locationId, location, can, options, email }) {
  const [sub, setSub] = useState("roster");
  return (
    <div className="space-y-4">
      <Sub value={sub} onChange={setSub} tabs={[["roster", "Staff shifts"], ["checklists", "Opening / closing checklists"], ["incidents", "Incidents"]]} />
      {sub === "roster" && <Roster orgId={orgId} locationId={locationId} location={location} email={email} />}
      {sub === "checklists" && <Checklists orgId={orgId} locationId={locationId} />}
      {sub === "incidents" && <Incidents orgId={orgId} locationId={locationId} can={can} options={options} />}
      <p className={muted}>Day-to-day jobs are in <a className="underline" href="/business?view=tasks">Tasks</a>; employee records and leave are in <a className="underline" href="/business?view=hr">HR</a>.</p>
    </div>
  );
}

const monday = (d) => { const t = new Date(`${d}T00:00:00Z`); const wd = (t.getUTCDay() + 6) % 7; return addDays(d, -wd); };
function Roster({ orgId, locationId, location, email }) {
  const [week, setWeek] = useState(monday(today()));
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "roster", { locationId, weekStart: week })), [orgId, locationId, week]);
  const { busy, msg, run } = useAction();
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const me = String(email || "").toLowerCase();
  const add = (e, allowOverlap = false) => { e.preventDefault(); const fd = new FormData(e.target); run(() => send(orgId, "roster/shifts", "POST", { locationId, email: fd.get("email"), role: fd.get("role"), date: fd.get("date"), startTime: fd.get("start"), endTime: fd.get("end"), note: fd.get("note"), allowOverlap }), (r) => (r.warnings?.length ? `Shift added. Note: ${r.warnings.map((w) => w.message).join(" ")}` : "Shift added as a draft.")).then((x) => x && reload()); };
  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center flex-wrap"><button className={ghost} onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button><span className="text-sm text-[var(--inaya-text-primary)]">Week of {week}</span><button className={ghost} onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">›</button><span className={muted}>Times in {location.timeZone}</span>
        {data?.canEdit && data.draftCount > 0 && <Confirm text={`Publish ${data.draftCount} shift${data.draftCount > 1 ? "s" : ""}? Staff will be notified.`} className={primary} disabled={busy} onYes={() => run(() => send(orgId, "roster/publish", "POST", { locationId, weekStart: week }), (r) => `${r.published} shifts published and staff notified.`).then(reload)}>Publish {data.draftCount} draft{data.draftCount > 1 ? "s" : ""}</Confirm>}
      </div>
      <Msg msg={msg} />
      {data?.canEdit && (
        <form className={`${panel} flex gap-3 flex-wrap items-end`} onSubmit={add}>
          <Field label="Staff member"><select name="email" className={input} required><option value="">Choose…</option>{data.staff.map((s) => <option key={s.email} value={s.email}>{s.name || s.email}{s.jobTitle ? ` (${s.jobTitle})` : ""}</option>)}</select></Field>
          <Field label="Role"><select name="role" className={input}>{data.roles.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
          <Field label="Date"><select name="date" className={input}>{days.map((d) => <option key={d} value={d}>{new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</option>)}</select></Field>
          <Field label="Start"><input name="start" type="time" className={input} required /></Field>
          <Field label="End"><input name="end" type="time" className={input} required /></Field>
          <Field label="Note"><input name="note" className={input} /></Field>
          <button className={primary} disabled={busy}>Add shift</button>
          {msg && !msg.ok && /overlaps/i.test(msg.text) && <button type="button" className={ghost} onClick={(e) => add({ preventDefault() {}, target: e.target.form }, true)}>Add anyway</button>}
        </form>
      )}
      <State loading={loading} error={error}>
        <div className="grid md:grid-cols-2 xl:grid-cols-7 gap-3">{days.map((d) => {
          const list = (data?.shifts || []).filter((s) => s.date === d);
          const leave = (data?.leave || []).filter((l) => l.from <= d && l.to >= d), off = (data?.unavailable || []).filter((u) => u.date === d);
          return (
            <div key={d} className={`${panel} !p-3`}>
              <h4 className="text-[12px] font-bold text-[var(--inaya-text-primary)] mb-2">{new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</h4>
              {!list.length && <p className={muted}>No shifts</p>}
              <div className="space-y-2">{list.map((s) => (
                <div key={s.id} className="bg-black/20 border border-white/5 rounded-lg p-2 text-[12px] text-[var(--inaya-text-primary)]">
                  <p>{s.startTime} to {s.endTime} · {label(s.role)}</p><p className={muted}>{s.name || s.email}{s.status === "DRAFT" ? " · draft" : ""}{s.note ? ` · ${s.note}` : ""}</p>
                  {s.swap?.status === "PENDING" && <p className="text-amber-400">Swap requested → {s.swap.toEmail}</p>}
                  <div className="flex gap-1 flex-wrap mt-1">
                    {data.canEdit && s.swap?.status === "PENDING" && <><button className={ghost} disabled={busy} onClick={() => run(() => send(orgId, `roster/shifts/${s.id}/swap/decide`, "POST", { approve: true, allowOverlap: true }), "Swap approved.").then(reload)}>Approve</button><button className={ghost} disabled={busy} onClick={() => run(() => send(orgId, `roster/shifts/${s.id}/swap/decide`, "POST", { approve: false }), "Swap declined.").then(reload)}>Decline</button></>}
                    {data.canEdit && <Confirm text="Remove this shift?" className={danger} disabled={busy} onYes={() => run(() => send(orgId, `roster/shifts/${s.id}`, "DELETE"), "Shift removed.").then(reload)}>Remove</Confirm>}
                    {!data.canEdit && s.email === me && s.status === "PUBLISHED" && !s.swap && <button className={ghost} disabled={busy} onClick={() => { const to = window.prompt("Email of the colleague who will take this shift:"); if (to) run(() => send(orgId, `roster/shifts/${s.id}/swap`, "POST", { toEmail: to }), "Swap requested. A manager will decide.").then(reload); }}>Ask to swap</button>}
                  </div>
                </div>
              ))}</div>
              {leave.map((l, i) => <p key={i} className="text-[11px] text-amber-400 mt-1">On leave: {l.email}</p>)}
              {off.map((u) => <p key={u.id} className="text-[11px] text-amber-400 mt-1">Unavailable: {u.email}</p>)}
              <button className={`${ghost} mt-2`} disabled={busy} onClick={() => { const mine = off.find((u) => u.email === me); run(() => send(orgId, "roster/unavailable", "PUT", { date: d, remove: !!mine }), mine ? "Marked available again." : "Marked unavailable.").then(reload); }}>{off.some((u) => u.email === me) ? "I'm available" : "I can't work"}</button>
            </div>
          );
        })}</div>
      </State>
    </div>
  );
}

function Checklists({ orgId, locationId }) {
  const [date, setDate] = useState(today());
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "checklists", { locationId, date })), [orgId, locationId, date]);
  const [draft, setDraft] = useState(null);
  const { busy, msg, run } = useAction();
  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap"><Field label="Date"><input type="date" className={input} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
        {data?.canManage && <button className={ghost} onClick={() => setDraft(draft ? null : { name: "Opening checklist", type: "opening", items: data.suggestions.opening.join("\n") })}>{draft ? "Close" : "New checklist template"}</button>}
      </div>
      <Msg msg={msg} />
      {draft && (
        <form className={`${panel} space-y-3`} onSubmit={(e) => { e.preventDefault(); run(() => send(orgId, "checklists/templates", "POST", { locationId, name: draft.name, type: draft.type, items: draft.items.split("\n").map((s) => s.trim()).filter(Boolean).map((s) => { const m = /^(.*?)\s*@\s*(\d{2}:\d{2})\s*(\*)?$/.exec(s); return m ? { label: m[1], dueTime: m[2], requiresEvidence: !!m[3] } : { label: s.replace(/\*$/, "").trim(), requiresEvidence: /\*$/.test(s) }; }) }), "Template saved.").then((x) => { if (x) { setDraft(null); reload(); } }); }}>
          <div className="flex gap-3 flex-wrap"><Field label="Name"><input className={input} required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="Type"><select className={input} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value, items: data.suggestions[e.target.value]?.join("\n") || draft.items })}>{data.types.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field></div>
          <Field label="Items, one per line" hint="Add @ 10:30 for a due time, and * at the end if a photo or document is needed. Example: Check fridge temperatures @ 09:00 *"><textarea className={`${input} h-44`} value={draft.items} onChange={(e) => setDraft({ ...draft, items: e.target.value })} /></Field>
          <button className={primary} disabled={busy}>Save template</button>
        </form>
      )}
      <State loading={loading} error={error} empty={data && !data.templates.length} emptyText="No checklists yet. A manager can create opening and closing checklists.">
        {(data?.templates || []).filter((t) => t.active).map((t) => {
          const run1 = data.runs.find((r) => r.templateId === t.id);
          return (
            <div key={t.id} className={panel}>
              <div className="flex justify-between items-center gap-2 flex-wrap mb-3"><h3 className="text-[var(--inaya-text-primary)] font-semibold text-sm">{t.name} <span className={muted}>({label(t.type)})</span></h3>
                <span className="flex gap-2 items-center">{run1 ? <span className={run1.status === "COMPLETED" ? "text-emerald-400 text-[12px]" : "text-amber-400 text-[12px]"}>{run1.items.filter((i) => i.done).length}/{run1.items.length} done</span> : <button className={primary} disabled={busy} onClick={() => run(() => send(orgId, "checklists/runs", "POST", { templateId: t.id, date }), "Checklist started.").then(reload)}>Start for {date}</button>}
                  {data.canManage && <Confirm text={`Remove the "${t.name}" template? Past runs are kept.`} className={danger} disabled={busy} onYes={() => run(() => send(orgId, "checklists/templates", "POST", { locationId, templateId: t.id, remove: true }), "Template removed.").then(reload)}>Remove</Confirm>}</span>
              </div>
              {run1 && <div className="space-y-2">{run1.items.map((i) => {
                const late = !i.done && i.dueAt && new Date(i.dueAt) < new Date();
                return (
                  <label key={i.n} className={`${row} cursor-pointer`}>
                    <span className="flex items-center gap-2 text-sm text-[var(--inaya-text-primary)]"><input type="checkbox" checked={i.done} disabled={busy} onChange={(e) => run(() => send(orgId, `checklists/runs/${run1.id}`, "PATCH", { n: i.n, done: e.target.checked })).then(reload)} />{i.label}{i.requiresEvidence ? " (needs a photo or document)" : ""}</span>
                    <span className={late ? "text-red-400 text-[12px]" : muted}>{i.done ? `${i.doneByEmail}, ${new Date(i.doneAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : i.dueAt ? `${late ? "Overdue, due" : "Due"} ${new Date(i.dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
                  </label>
                );
              })}</div>}
            </div>
          );
        })}
      </State>
      <p className={muted}>The cash-close item only records that the count was done. No cash is processed here.</p>
    </div>
  );
}

function Incidents({ orgId, locationId, can, options }) {
  const [data, reload, error, loading] = useLoad(() => api(H(orgId, "incidents", { locationId })), [orgId, locationId]);
  const [open, setOpen] = useState(null);
  const [detail, reloadDetail] = useLoad(() => (open ? api(H(orgId, `incidents/${open}`)) : Promise.resolve(null)), [orgId, open]);
  const { busy, msg, run } = useAction();
  const i = detail?.incident;
  const update = (body, ok) => run(() => send(orgId, `incidents/${open}`, "PATCH", body), ok).then((x) => { if (x) { reload(); reloadDetail(); } });
  return (
    <div className="space-y-4">
      <form className={`${panel} flex gap-3 flex-wrap items-end`} onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.target); run(() => send(orgId, "incidents", "POST", { locationId, category: fd.get("category"), severity: fd.get("severity"), summary: fd.get("summary"), details: fd.get("details") }), "Incident recorded and managers notified.").then((x) => { if (x) { e.target.reset(); reload(); } }); }}>
        <Field label="What happened"><select name="category" className={input}>{(options?.incidentCategories || []).map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
        <Field label="Severity"><select name="severity" className={input} defaultValue="medium"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
        <Field label="Summary" className="flex-1 min-w-[200px]"><input name="summary" className={input} required maxLength={160} /></Field>
        <Field label="Details" className="flex-1 min-w-[200px]"><input name="details" className={input} /></Field>
        <button className={primary} disabled={busy}>Record incident</button>
      </form>
      <Msg msg={msg} />
      <div className={panel}>
        <h3 className={h3}>{can.incidentsAll ? "Incidents" : "Incidents you raised or own"}</h3>
        <State loading={loading} error={error} empty={!data?.incidents?.length} emptyText="No incidents.">
          <div className="space-y-2">{(data?.incidents || []).map((x) => (
            <button key={x.id} className={`${row} w-full text-left`} onClick={() => setOpen(open === x.id ? null : x.id)}>
              <span className="text-sm text-[var(--inaya-text-primary)]">{x.ref} · {label(x.category)} · {x.summary}</span>
              <span className={x.status === "RESOLVED" ? muted : "text-amber-400 text-[12px]"}>{label(x.severity)} · {label(x.status)}{x.assignedToEmail ? ` · ${x.assignedToEmail}` : ""}</span>
            </button>
          ))}</div>
        </State>
      </div>
      {open && i && (
        <div className={`${panel} space-y-3`}>
          <h3 className={h3}>{i.ref}: {i.summary}</h3>
          {i.details && <p className="text-sm text-[var(--inaya-text-primary)]">{i.details}</p>}
          {i.resolution && <p className={muted}>Resolution: {i.resolution}</p>}
          <div className="flex gap-2 flex-wrap">
            {i.status !== "RESOLVED" && i.status !== "IN_PROGRESS" && <button className={ghost} disabled={busy} onClick={() => update({ toStatus: "IN_PROGRESS" }, "In progress.")}>Start work</button>}
            {i.status !== "RESOLVED" && i.status !== "ESCALATED" && <button className={ghost} disabled={busy} onClick={() => update({ toStatus: "ESCALATED", note: window.prompt("Why is this being escalated?") || "" }, "Escalated. Managers have been notified.")}>Escalate</button>}
            {i.status !== "RESOLVED" && <button className={primary} disabled={busy} onClick={() => { const r = window.prompt("How was this resolved?"); if (r) update({ toStatus: "RESOLVED", resolution: r }, "Resolved."); }}>Resolve</button>}
            {can.incidentsAll && <button className={ghost} disabled={busy} onClick={() => { const to = window.prompt("Assign to (email):", i.assignedToEmail || ""); if (to !== null) update({ assignedToEmail: to }, "Assigned."); }}>Assign</button>}
          </div>
          <details><summary className={`${muted} cursor-pointer`}>History</summary>{i.history.map((h, n) => <p key={n} className={muted}>{new Date(h.at).toLocaleString()} · {h.by}{h.to ? ` · ${label(h.to)}` : ""}{h.note ? ` · ${h.note}` : ""}</p>)}</details>
        </div>
      )}
    </div>
  );
}
