// src/lib/hospitality/menu.js
//
// Menu catalogue, modifiers, allergen and dietary information, recipes and availability (SOW 10).
// Ingredients are ordinary Inventory products: a recipe only references them. Stock is never deducted from menu
// sales here (SOW 10.4: that needs a verified order event from a POS, which isn't integrated).
//
// Publishing rule: kitchen staff draft; a manager publishes. Price and allergen changes on a published item are
// manager-only and written to the audit chain with the old and new values (SOW 10.5, 20.3).

import { getOrgCollections, toObjectId } from "../orgs.js";
import { DAY_KEYS, minutesOf } from "../engagement/time.js";
import { hcol, KINDS, CAN, fail, clean, nowIso, oid, sid, intIn, logH, emitH, allowedLocations, ensureHospitalityIndexes } from "./store.js";

export const ITEM_STATUSES = ["draft", "active", "unavailable", "archived"];
export const ALLERGENS = ["gluten", "crustaceans", "eggs", "fish", "peanuts", "soy", "milk", "tree_nuts", "celery", "mustard", "sesame", "sulphites", "lupin", "molluscs"];
export const DIETARY = ["vegetarian", "vegan", "halal", "kosher", "gluten_free", "dairy_free", "nut_free", "spicy"];
export const ALLERGEN_DISCLAIMER = "Allergen and dietary information is provided by the restaurant, which remains responsible for ingredient accuracy and cross-contamination practices. It is not medical advice.";

// ---- units (SOW 10.3: conversion rules) ----
const UNIT_FACTORS = { mg: ["mass", 0.001], g: ["mass", 1], kg: ["mass", 1000], oz: ["mass", 28.3495], lb: ["mass", 453.592], ml: ["volume", 1], cl: ["volume", 10], l: ["volume", 1000], tsp: ["volume", 4.92892], tbsp: ["volume", 14.7868], cup: ["volume", 240] };
const unitKey = (u) => String(u || "").trim().toLowerCase().replace(/s$/, "").replace(/^litre$|^liter$/, "l").replace(/^gram$/, "g").replace(/^kilogram$|^kilo$/, "kg");

/** Pure: converts between units of the same kind (mass or volume). Returns null when it can't be converted honestly. */
export function convertQuantity(quantity, fromUnit, toUnit) {
  const a = unitKey(fromUnit), b = unitKey(toUnit);
  if (!Number.isFinite(quantity)) return null;
  if (a === b) return quantity;
  const fa = UNIT_FACTORS[a], fb = UNIT_FACTORS[b];
  if (!fa || !fb || fa[0] !== fb[0]) return null;
  return (quantity * fa[1]) / fb[1];
}

/** Pure: validates modifier groups (size, add-ons, preparation). Kept simple on purpose (SOW 10.2). */
export function normalizeModifiers(input) {
  const groups = Array.isArray(input) ? input : [];
  if (groups.length > 12) return { error: "At most 12 option groups per item." };
  const out = [];
  for (const g of groups) {
    const name = clean(g?.name, 60);
    if (!name) return { error: "Each option group needs a name, for example Size." };
    const options = [];
    for (const o of Array.isArray(g.options) ? g.options.slice(0, 30) : []) {
      const on = clean(o?.name, 60), delta = o?.priceDeltaMinor === undefined || o?.priceDeltaMinor === "" ? 0 : Number(o.priceDeltaMinor);
      if (!on || !Number.isInteger(delta) || Math.abs(delta) > 1e9) return { error: "Each option needs a name and a whole-number price change." };
      options.push({ name: on, priceDeltaMinor: delta });
    }
    if (!options.length) return { error: `Add at least one option to "${name}".` };
    out.push({ name, required: g.required === true, multiple: g.multiple === true, options });
  }
  return { modifiers: out };
}

/** Pure: validates { days:[mon..], from, to }; empty means always available. */
export function normalizeAvailability(input) {
  if (!input || (!input.days?.length && !input.from && !input.to)) return { availability: null };
  const days = (Array.isArray(input.days) ? input.days : []).filter((d) => DAY_KEYS.includes(d));
  const from = input.from || "00:00", to = input.to || "24:00";
  if (minutesOf(from) === null || minutesOf(to) === null || minutesOf(to) <= minutesOf(from)) return { error: "Availability hours must look like 11:00 to 15:00." };
  return { availability: { days: days.length ? days : DAY_KEYS, from, to } };
}

/** Pure: validates recipe ingredients against the products they reference. */
export function normalizeRecipe(input, productsById) {
  if (!input) return { recipe: null };
  const yieldServings = Number(input.yieldServings ?? 1);
  if (!Number.isFinite(yieldServings) || yieldServings <= 0) return { error: "The recipe yield (servings it makes) must be more than zero." };
  const list = Array.isArray(input.ingredients) ? input.ingredients : [];
  if (!list.length) return { error: "Add at least one ingredient, or remove the recipe." };
  if (list.length > 100) return { error: "A recipe may have at most 100 ingredients." };
  const seen = new Set(), ingredients = [];
  for (const i of list) {
    const p = productsById.get(String(i?.productId));
    const q = Number(i?.quantity);
    if (!p) return { error: "An ingredient wasn't found in Inventory." };
    if (!Number.isFinite(q) || q <= 0) return { error: `Give a quantity for ${p.name}.` };
    if (seen.has(String(p._id))) return { error: `${p.name} is listed twice; add the quantities together.` };
    seen.add(String(p._id));
    const unit = clean(i.unit, 20) || p.unit || "unit";
    const inStockUnits = convertQuantity(q, unit, p.unit || unit);
    if (inStockUnits === null) return { error: `${p.name} is stocked in ${p.unit || "units"}; ${unit} can't be converted to that.` };
    ingredients.push({ productId: p._id, quantity: q, unit, stockQuantity: inStockUnits, substitution: clean(i.substitution, 200) || null });
  }
  return { recipe: { yieldServings, servingNote: clean(input.servingNote, 120) || null, method: clean(input.method, 4000) || null, ingredients } };
}

const itemView = (i, extra = {}) => ({
  id: sid(i._id), menuId: sid(i.menuId), categoryId: sid(i.categoryId), name: i.name, description: i.description || null, priceMinor: i.priceMinor, currency: i.currency,
  status: i.status, displayOrder: i.displayOrder || 0, locationIds: (i.locationIds || []).map(String), availability: i.availability || null, dietary: i.dietary || [], allergens: i.allergens || [],
  allergenReview: i.allergenReview || null, imageDocumentId: sid(i.imageDocumentId), modifiers: i.modifiers || [], manualUnavailable: i.manualUnavailable || null,
  recipe: i.recipe ? { ...i.recipe, ingredients: i.recipe.ingredients.map((x) => ({ ...x, productId: String(x.productId) })), version: i.recipeVersion || 1 } : null,
  updatedAt: i.updatedAt, ...extra,
});

// ---- menus and categories ----
export async function getCatalogue({ orgId, membership, locationId, includeArchived }) {
  if (!CAN.menuRead(membership)) return fail("You don't have access to the menu.", 403);
  await ensureHospitalityIndexes();
  const c = await hcol();
  const org = toObjectId(orgId);
  const [menus, categories, items] = await Promise.all([
    c.find({ orgId: org, kind: KINDS.menu, deletedAt: null }).sort({ createdAt: 1 }).limit(50).toArray(),
    c.find({ orgId: org, kind: KINDS.category, deletedAt: null }).sort({ order: 1, name: 1 }).limit(300).toArray(),
    c.find({ orgId: org, kind: KINDS.item, ...(includeArchived ? {} : { status: { $ne: "archived" } }) }).sort({ displayOrder: 1, name: 1 }).limit(2000).toArray(),
  ]);
  const scoped = oid(locationId) ? items.filter((i) => !(i.locationIds || []).length || i.locationIds.some((l) => String(l) === String(locationId))) : items;
  return {
    menus: menus.map((m) => ({ id: sid(m._id), name: m.name, version: m.version || 1, status: m.status, notes: m.notes || null })),
    categories: categories.map((x) => ({ id: sid(x._id), menuId: sid(x.menuId), name: x.name, order: x.order || 0 })),
    items: scoped.map((i) => itemView(i)), allergens: ALLERGENS, dietary: DIETARY, disclaimer: ALLERGEN_DISCLAIMER,
    can: { edit: CAN.menuEdit(membership), publish: CAN.menuPublish(membership) },
  };
}

export async function saveMenu({ orgId, membership, actorEmail, menuId, name, notes, status, newVersion }) {
  if (!CAN.menuPublish(membership)) return fail("Only a manager can change menus.", 403);
  const n = clean(name, 80);
  if (!n) return fail("Give the menu a name, for example Dinner.");
  if (status && !["draft", "active", "archived"].includes(status)) return fail("Menu status must be draft, active or archived.");
  const c = await hcol();
  if (menuId) {
    const r = await c.findOneAndUpdate({ _id: oid(menuId), orgId: toObjectId(orgId), kind: KINDS.menu, deletedAt: null }, { $set: { name: n, notes: clean(notes, 500) || null, ...(status ? { status } : {}), updatedAt: nowIso() }, ...(newVersion === true ? { $inc: { version: 1 } } : {}) }, { returnDocument: "after" });
    const m = r?.value ?? r;
    if (!m) return fail("Menu not found.", 404);
    await logH({ orgId, recordType: "MENU", recordId: m._id, actorEmail, action: newVersion === true ? "MENU_VERSION_PUBLISHED" : "MENU_UPDATED", metadata: { name: n, version: m.version, status: m.status } });
    return { menu: { id: sid(m._id), name: m.name, version: m.version, status: m.status } };
  }
  const doc = { orgId: toObjectId(orgId), kind: KINDS.menu, name: n, notes: clean(notes, 500) || null, status: status || "draft", version: 1, createdByEmail: actorEmail, createdAt: nowIso(), updatedAt: nowIso(), deletedAt: null };
  const r = await c.insertOne(doc);
  await logH({ orgId, recordType: "MENU", recordId: r.insertedId, actorEmail, action: "MENU_CREATED", metadata: { name: n } });
  return { menu: { id: sid(r.insertedId), name: n, version: 1, status: doc.status } };
}

export async function saveCategory({ orgId, membership, actorEmail, categoryId, menuId, name, order, remove }) {
  if (!CAN.menuEdit(membership)) return fail("You don't have permission to edit the menu.", 403);
  const c = await hcol();
  const org = toObjectId(orgId);
  if (remove && categoryId) {
    if (await c.countDocuments({ orgId: org, kind: KINDS.item, categoryId: oid(categoryId), status: { $ne: "archived" } })) return fail("Move or archive the items in this category first.", 409);
    const r = await c.updateOne({ _id: oid(categoryId), orgId: org, kind: KINDS.category, deletedAt: null }, { $set: { deletedAt: nowIso() } });
    return r.matchedCount ? { ok: true } : fail("Category not found.", 404);
  }
  const n = clean(name, 60);
  if (!n) return fail("Give the category a name, for example Starters.");
  const menu = await c.findOne({ _id: oid(menuId), orgId: org, kind: KINDS.menu, deletedAt: null });
  if (!menu) return fail("Choose a menu for the category.", 404);
  const set = { name: n, menuId: menu._id, order: intIn(order, 0, 999) ?? 0, updatedAt: nowIso() };
  if (categoryId) {
    const r = await c.updateOne({ _id: oid(categoryId), orgId: org, kind: KINDS.category, deletedAt: null }, { $set: set });
    if (!r.matchedCount) return fail("Category not found.", 404);
    return { category: { id: String(categoryId), menuId: sid(menu._id), name: n, order: set.order } };
  }
  const r = await c.insertOne({ orgId: org, kind: KINDS.category, ...set, createdAt: nowIso(), deletedAt: null });
  await logH({ orgId, recordType: "MENU", recordId: r.insertedId, actorEmail, action: "CATEGORY_CREATED", metadata: { name: n } });
  return { category: { id: sid(r.insertedId), menuId: sid(menu._id), name: n, order: set.order } };
}

// ---- items ----
export async function saveItem({ orgId, membership, actorEmail, itemId, ...body }) {
  if (!CAN.menuEdit(membership)) return fail("You don't have permission to edit the menu.", 403);
  const publish = CAN.menuPublish(membership);
  const c = await hcol();
  const org = toObjectId(orgId);
  const existing = itemId ? await c.findOne({ _id: oid(itemId), orgId: org, kind: KINDS.item }) : null;
  if (itemId && !existing) return fail("Menu item not found.", 404);
  const set = {};
  if (body.name !== undefined || !existing) { const n = clean(body.name, 120); if (!n) return fail("Give the item a name."); set.name = n; }
  if (body.description !== undefined) set.description = clean(body.description, 600) || null;
  if (body.categoryId !== undefined || !existing) {
    const cat = await c.findOne({ _id: oid(body.categoryId), orgId: org, kind: KINDS.category, deletedAt: null });
    if (!cat) return fail("Choose a category for the item.", 404);
    set.categoryId = cat._id; set.menuId = cat.menuId;
  }
  if (body.priceMinor !== undefined || !existing) { const p = Number(body.priceMinor); if (!Number.isInteger(p) || p < 0 || p > 1e10) return fail("Price must be a whole number in the smallest currency unit (for example 125000 for 1,250.00)."); set.priceMinor = p; }
  if (body.currency !== undefined || !existing) { const cur = String(body.currency ?? "").trim().toUpperCase(); if (!/^[A-Z]{3}$/.test(cur)) return fail("Choose a three-letter currency code."); set.currency = cur; }
  if (body.displayOrder !== undefined) set.displayOrder = intIn(body.displayOrder, 0, 9999) ?? 0;
  if (body.imageDocumentId !== undefined) set.imageDocumentId = oid(body.imageDocumentId);
  if (body.locationIds !== undefined) {
    const mine = new Set((await allowedLocations(orgId, membership)).map((l) => String(l._id)));
    const ids = [...new Set((Array.isArray(body.locationIds) ? body.locationIds : []).map(String))];
    if (ids.some((x) => !mine.has(x))) return fail("One of those locations isn't available to you.", 404);
    set.locationIds = ids.map((x) => toObjectId(x));
  }
  if (body.availability !== undefined) { const a = normalizeAvailability(body.availability); if (a.error) return fail(a.error); set.availability = a.availability; }
  if (body.modifiers !== undefined) { const m = normalizeModifiers(body.modifiers); if (m.error) return fail(m.error); set.modifiers = m.modifiers; }
  if (body.dietary !== undefined) set.dietary = [...new Set((Array.isArray(body.dietary) ? body.dietary : []).filter((d) => DIETARY.includes(d)))];
  if (body.allergens !== undefined) set.allergens = [...new Set((Array.isArray(body.allergens) ? body.allergens : []).filter((d) => ALLERGENS.includes(d)))];
  if (body.status !== undefined) { if (!ITEM_STATUSES.includes(body.status)) return fail(`Status must be one of: ${ITEM_STATUSES.join(", ")}.`); set.status = body.status; }

  const live = existing && existing.status !== "draft";
  const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
  const priceChanged = existing && set.priceMinor !== undefined && set.priceMinor !== existing.priceMinor;
  const allergenChanged = existing && ((set.allergens && !same(set.allergens, existing.allergens)) || (set.dietary && !same(set.dietary, existing.dietary)));
  const goingLive = (set.status || existing?.status || "draft") !== "draft" && (!existing || existing.status === "draft");
  if (!publish) {
    if (goingLive || (set.status && set.status !== (existing?.status || "draft"))) return fail("A manager has to publish, archive or change the availability of a menu item.", 403);
    if (live && (priceChanged || allergenChanged)) return fail("Prices and allergen information on a published item can only be changed by a manager.", 403);
  }
  // Allergen and dietary information counts as reviewed only when a manager saves it (SOW 10.5).
  if ((set.allergens || set.dietary) && publish) set.allergenReview = { reviewedByEmail: actorEmail, reviewedAt: nowIso() };
  else if (allergenChanged || (!existing && (set.allergens?.length || set.dietary?.length))) set.allergenReview = null;
  if (goingLive && !(set.allergenReview ?? existing?.allergenReview)) return fail("Review and save the allergen and dietary information before publishing this item.", 409);
  set.updatedAt = nowIso(); set.updatedByEmail = actorEmail;

  let doc;
  if (existing) { await c.updateOne({ _id: existing._id, orgId: org, kind: KINDS.item }, { $set: set }); doc = { ...existing, ...set }; }
  else { doc = { orgId: org, kind: KINDS.item, status: "draft", locationIds: [], dietary: [], allergens: [], modifiers: [], availability: null, recipe: null, displayOrder: 0, ...set, createdByEmail: actorEmail, createdAt: nowIso() }; doc._id = (await c.insertOne(doc)).insertedId; }
  await logH({ orgId, recordType: "MENU_ITEM", recordId: doc._id, actorEmail, action: existing ? "MENU_ITEM_UPDATED" : "MENU_ITEM_CREATED", metadata: { name: doc.name, fields: Object.keys(set).filter((k) => !k.startsWith("updated")) } });
  if (priceChanged) await logH({ orgId, recordType: "MENU_ITEM", recordId: doc._id, actorEmail, action: "MENU_PRICE_CHANGED", previousState: String(existing.priceMinor), newState: String(set.priceMinor), metadata: { name: doc.name, currency: doc.currency } });
  if (allergenChanged) await logH({ orgId, recordType: "MENU_ITEM", recordId: doc._id, actorEmail, action: "ALLERGEN_INFO_CHANGED", metadata: { name: doc.name, from: { allergens: existing.allergens || [], dietary: existing.dietary || [] }, to: { allergens: doc.allergens, dietary: doc.dietary } } });
  return { item: itemView(doc) };
}

/** Marks an item unavailable or available again. Always a deliberate, attributed action (SOW 10.4). */
export async function setItemAvailability({ orgId, membership, actorEmail, itemId, available, reason }) {
  if (!CAN.menuEdit(membership)) return fail("You don't have permission to change availability.", 403);
  const c = await hcol();
  const item = await c.findOne({ _id: oid(itemId), orgId: toObjectId(orgId), kind: KINDS.item });
  if (!item) return fail("Menu item not found.", 404);
  if (!["active", "unavailable"].includes(item.status)) return fail("Only a published item can be switched on or off.", 409);
  const set = available ? { status: "active", manualUnavailable: null } : { status: "unavailable", manualUnavailable: { byEmail: actorEmail, at: nowIso(), reason: clean(reason, 200) || null } };
  await c.updateOne({ _id: item._id }, { $set: { ...set, updatedAt: nowIso() } });
  await logH({ orgId, recordType: "MENU_ITEM", recordId: item._id, actorEmail, action: available ? "MENU_ITEM_AVAILABLE" : "MENU_ITEM_UNAVAILABLE", previousState: item.status, newState: set.status, metadata: { name: item.name, reason: clean(reason, 200) || null } });
  emitH(orgId, available ? "menu.item_available" : "menu.item_unavailable", `${item._id}:${Date.now()}`, { item: { id: String(item._id), name: item.name } });
  return { item: itemView({ ...item, ...set }) };
}

// ---- recipes ----
async function productsMap(orgId, ids) {
  const { products } = await getOrgCollections();
  const rows = ids.length ? await products.find({ _id: { $in: ids.map((x) => oid(x)).filter(Boolean) }, orgId: toObjectId(orgId), deletedAt: null }).toArray() : [];
  return new Map(rows.map((p) => [String(p._id), p]));
}

export async function saveRecipe({ orgId, membership, actorEmail, itemId, recipe }) {
  if (!CAN.menuEdit(membership)) return fail("You don't have permission to edit recipes.", 403);
  const c = await hcol();
  const item = await c.findOne({ _id: oid(itemId), orgId: toObjectId(orgId), kind: KINDS.item });
  if (!item) return fail("Menu item not found.", 404);
  const map = await productsMap(orgId, (recipe?.ingredients || []).map((i) => i?.productId).filter(Boolean));
  const n = normalizeRecipe(recipe, map);
  if (n.error) return fail(n.error);
  const version = (item.recipeVersion || 0) + 1;
  // The previous version is kept (last 20) so a change can be traced (SOW 10.3: recipe version history).
  const history = item.recipe ? [...(item.recipeHistory || []), { version: item.recipeVersion || 1, recipe: item.recipe, replacedAt: nowIso(), replacedByEmail: actorEmail }].slice(-20) : item.recipeHistory || [];
  await c.updateOne({ _id: item._id }, { $set: { recipe: n.recipe, recipeVersion: n.recipe ? version : item.recipeVersion || 0, recipeHistory: history, updatedAt: nowIso() } });
  await logH({ orgId, recordType: "MENU_ITEM", recordId: item._id, actorEmail, action: n.recipe ? "RECIPE_SAVED" : "RECIPE_REMOVED", metadata: { name: item.name, version, ingredients: n.recipe?.ingredients.length || 0 } });
  return { item: itemView({ ...item, recipe: n.recipe, recipeVersion: version }) };
}

/** Latest purchase cost per stock unit for each product, from received purchase-order lines. Missing = unknown, never guessed. */
async function latestCosts(orgId, productIds) {
  const { purchaseOrders } = await getOrgCollections();
  const rows = await purchaseOrders.find({ orgId: toObjectId(orgId), deletedAt: null, "items.productId": { $in: productIds } }).sort({ updatedAt: -1 }).limit(300).project({ items: 1, updatedAt: 1 }).toArray();
  const out = new Map();
  for (const po of rows) for (const i of po.items || []) {
    const k = String(i.productId || "");
    if (!k || out.has(k) || !Number.isFinite(i.unitPrice) || i.unitPrice === null) continue;
    const per = Number.isInteger(i.unitsPerPurchaseUnit) && i.unitsPerPurchaseUnit > 1 ? i.unitsPerPurchaseUnit : 1;
    out.set(k, { cost: i.unitPrice / per, asOf: po.updatedAt });
  }
  return out;
}

/** Pure: cost per serving from ingredient costs. Returns coverage so an incomplete figure is never shown as a fact (SOW 11.4). */
export function recipeCost(recipe, costByProduct) {
  if (!recipe?.ingredients?.length) return { status: "no_recipe" };
  let total = 0, known = 0;
  for (const i of recipe.ingredients) { const c = costByProduct.get(String(i.productId)); if (c) { total += c.cost * i.stockQuantity; known++; } }
  const coverage = known / recipe.ingredients.length;
  if (known < recipe.ingredients.length) return { status: "insufficient_data", coverage, missing: recipe.ingredients.length - known };
  return { status: "estimate", coverage: 1, costPerServing: total / recipe.yieldServings, batchCost: total };
}

/** Recipe view with ingredient names, stock on hand, servings possible and an estimated cost (clearly labelled). */
export async function recipeDetail({ orgId, membership, itemId }) {
  if (!CAN.menuRead(membership)) return fail("You don't have access to the menu.", 403);
  const c = await hcol();
  const item = await c.findOne({ _id: oid(itemId), orgId: toObjectId(orgId), kind: KINDS.item });
  if (!item) return fail("Menu item not found.", 404);
  if (!item.recipe) return { item: itemView(item), ingredients: [], cost: { status: "no_recipe" }, history: [] };
  const ids = item.recipe.ingredients.map((i) => i.productId);
  const [map, stock, costs] = await Promise.all([productsMap(orgId, ids.map(String)), stockTotals(orgId, ids), latestCosts(orgId, ids)]);
  const ingredients = item.recipe.ingredients.map((i) => { const p = map.get(String(i.productId)); const on = stock.get(String(i.productId)) || 0; return { productId: String(i.productId), name: p?.name || "Removed product", sku: p?.sku || null, quantity: i.quantity, unit: i.unit, stockUnit: p?.unit || "unit", stockQuantity: i.stockQuantity, onHand: on, servingsPossible: i.stockQuantity > 0 ? Math.floor((on / i.stockQuantity) * item.recipe.yieldServings) : null, substitution: i.substitution }; });
  const cost = recipeCost(item.recipe, costs);
  return { item: itemView(item), ingredients, servingsPossible: ingredients.length ? Math.min(...ingredients.map((i) => i.servingsPossible ?? Infinity)) : null, cost: { ...cost, currencyNote: "Estimated from the latest purchase-order prices. Not an actual food-cost figure: sales data isn't connected." }, history: CAN.menuEdit(membership) ? (item.recipeHistory || []).map((h) => ({ version: h.version, replacedAt: h.replacedAt, replacedByEmail: h.replacedByEmail, ingredients: h.recipe.ingredients.length })) : [] };
}

async function stockTotals(orgId, productIds) {
  const { stockLevels } = await getOrgCollections();
  const rows = productIds.length ? await stockLevels.aggregate([{ $match: { orgId: toObjectId(orgId), productId: { $in: productIds } } }, { $group: { _id: "$productId", q: { $sum: "$quantity" } } }]).toArray() : [];
  return new Map(rows.map((r) => [String(r._id), r.q]));
}

/**
 * Suggests switching items off when a recipe ingredient is at or below its reorder level or can't cover one
 * serving. A suggestion only: staff confirm each change with setItemAvailability (SOW 10.4).
 */
export async function availabilitySuggestions({ orgId, membership }) {
  if (!CAN.menuRead(membership)) return fail("You don't have access to the menu.", 403);
  const c = await hcol();
  const items = await c.find({ orgId: toObjectId(orgId), kind: KINDS.item, status: "active", "recipe.ingredients.0": { $exists: true } }).limit(1000).toArray();
  const ids = [...new Set(items.flatMap((i) => i.recipe.ingredients.map((x) => String(x.productId))))];
  const [map, stock] = await Promise.all([productsMap(orgId, ids), stockTotals(orgId, ids.map((x) => toObjectId(x)))]);
  const suggestions = [];
  for (const i of items) {
    const short = i.recipe.ingredients.map((x) => { const p = map.get(String(x.productId)); const on = stock.get(String(x.productId)) || 0; const perServing = x.stockQuantity / i.recipe.yieldServings; const low = (p?.reorderThreshold || 0) > 0 && on <= p.reorderThreshold; return on < perServing || low ? { name: p?.name || "Removed product", onHand: on, unit: p?.unit || "unit", reason: on < perServing ? "Not enough for one serving" : "At or below the reorder level" } : null; }).filter(Boolean);
    if (short.length) suggestions.push({ itemId: String(i._id), name: i.name, ingredients: short });
  }
  return { suggestions, note: "Suggestions only. Nothing changes until someone marks an item unavailable." };
}

/** Ingredient picker for recipes: Inventory products (id, name, unit). Read-only. */
export async function listIngredients({ orgId, membership, q }) {
  if (!CAN.menuEdit(membership)) return fail("You don't have permission to edit recipes.", 403);
  const { products } = await getOrgCollections();
  const filter = { orgId: toObjectId(orgId), deletedAt: null };
  if (q) { const s = clean(q, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); filter.$or = [{ name: new RegExp(s, "i") }, { sku: new RegExp(s, "i") }]; }
  const rows = await products.find(filter).project({ name: 1, sku: 1, unit: 1 }).sort({ name: 1 }).limit(1000).toArray();
  return { ingredients: rows.map((p) => ({ productId: String(p._id), name: p.name, sku: p.sku, unit: p.unit || "unit" })) };
}
