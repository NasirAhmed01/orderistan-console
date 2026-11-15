// Industry-specific product rules shared by the seller routes (what may be saved) and the store routes (what a customer may buy).
const { Product, Booking } = require("./models");
const U = require("./utils");

const CATEGORIES = ["food", "clothing", "services"];
const txt = (v, n = 40) => String(v ?? "").trim().slice(0, n);
const num = (v, max = 1e7) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0; };
const flag = (v) => v !== false && v !== "false" && v !== 0;
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v).toLowerCase() : "#cccccc");

// ---- seller input -> clean fields (nothing from the browser is trusted blindly) -----------------------------------------------------
function cleanOptions(category, raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const out = {};
  if (o.stock === null || o.stock === "" || o.stock === undefined) out.stock = null; else out.stock = Math.floor(num(o.stock, 1e6));
  if (category === "food" || category === "clothing") {
    const d = o.deal || {}, kind = ["percent", "bogo", "combo"].includes(d.kind) ? d.kind : "";
    out.deal = { kind, value: kind === "percent" ? Math.min(90, num(d.value, 90)) : 0, label: txt(d.label, 40), items: kind === "combo" ? list(d.items, 12).map((x) => txt(x, 60)).filter(Boolean) : [] };
  }
  if (category === "food") {
    out.sizes = list(o.sizes, 8).map((s) => ({ name: txt(s.name, 30), price: num(s.price), enabled: flag(s.enabled) })).filter((s) => s.name);
    out.addons = list(o.addons, 30).map((a) => ({ name: txt(a.name, 40), price: num(a.price, 1e5), group: txt(a.group || "Toppings", 30) || "Toppings", enabled: flag(a.enabled) })).filter((a) => a.name);
  }
  if (category === "clothing") {
    out.sku = txt(o.sku, 40);
    const c = o.sizeChart || {};
    const columns = list(c.columns, 8).map((x) => txt(x, 24)).filter(Boolean);
    const seen = new Set();
    out.sizeChart = { unit: c.unit === "cm" ? "cm" : "in", columns,
      rows: list(c.rows, 16).map((r) => ({ size: txt(r.size, 12), enabled: flag(r.enabled), values: columns.map((_, i) => txt((r.values || [])[i], 12)) }))
        .filter((r) => r.size && !seen.has(r.size.toLowerCase()) && seen.add(r.size.toLowerCase())) };
    const cs = new Set();
    out.colors = list(o.colors, 12).map((x) => ({ name: txt(x.name, 30), hex: hex(x.hex), image: typeof x.image === "string" ? x.image : "", enabled: flag(x.enabled), _new: !!x.newImage }))
      .filter((x) => x.name && !cs.has(x.name.toLowerCase()) && cs.add(x.name.toLowerCase()));
    const sizeSet = new Set(out.sizeChart.rows.map((r) => r.size)), colSet = new Set(out.colors.map((x) => x.name));
    const vs = new Set();
    out.variants = list(o.variants, 200).map((v) => ({ size: txt(v.size, 12), color: txt(v.color, 30), sku: txt(v.sku, 40), stock: v.stock === null || v.stock === "" || v.stock === undefined ? null : Math.floor(num(v.stock, 1e6)), price: num(v.price), enabled: flag(v.enabled) }))
      .filter((v) => (!v.size || sizeSet.has(v.size)) && (!v.color || colSet.has(v.color)) && !vs.has(v.size + "|" + v.color) && vs.add(v.size + "|" + v.color));
  }
  if (category === "services") {
    out.duration = Math.floor(num(o.duration, 1440));
    out.bookingMode = o.bookingMode === "request" ? "request" : "booking";
    out.packages = list(o.packages, 10).map((p) => ({ name: txt(p.name, 50), price: num(p.price), duration: Math.floor(num(p.duration, 1440)), description: txt(p.description, 300), enabled: flag(p.enabled) })).filter((p) => p.name);
    out.addons = list(o.addons, 20).map((a) => ({ name: txt(a.name, 40), price: num(a.price, 1e5), group: "Add-ons", enabled: flag(a.enabled) })).filter((a) => a.name);
  }
  return out;
}

// ---- customer-facing view: disabled sizes / colours / options are removed so the browser never even sees them ----------------------------
function publicProduct(p) {
  const o = { ...p };
  if (o.sizes) o.sizes = o.sizes.filter((x) => x.enabled);
  if (o.addons) o.addons = o.addons.filter((x) => x.enabled);
  if (o.packages) o.packages = o.packages.filter((x) => x.enabled);
  if (o.colors) o.colors = o.colors.filter((x) => x.enabled);
  if (o.sizeChart?.rows) o.sizeChart = { ...o.sizeChart, rows: o.sizeChart.rows.filter((r) => r.enabled) };
  if (o.variants) o.variants = o.variants.filter((v) => v.enabled).map((v) => ({ size: v.size, color: v.color, stock: v.stock, price: v.price }));
  delete o.keywords; delete o.live;
  return o;
}

// ---- price of one cart line, always calculated on the server -----------------------------------------------------------------------
// item = { product, qty, size, color, addons: [names] }. Returns the order line plus the stock to take.
function priceLine(p, store, item) {
  const cat = store.category, qty = Math.min(99, Math.max(1, parseInt(item.qty) || 1));
  const bad = (m) => { throw U.fail(400, m); };
  let unit = p.price, size = "", color = "", sku = p.sku || "", addons = [], variant = null;
  if (cat === "food") {
    const sizes = (p.sizes || []).filter((s) => s.enabled);
    if (sizes.length) { const s = sizes.find((x) => x.name === item.size); if (!s) bad(`Choose a size for ${p.name}.`); size = s.name; unit = s.price; }
    const picked = [].concat(item.addons || []).map(String);
    for (const n of [...new Set(picked)].slice(0, 20)) { const a = (p.addons || []).find((x) => x.enabled && x.name === n); if (!a) bad(`"${n}" is no longer available for ${p.name}.`); addons.push(a.name); unit += a.price; }
  } else if (cat === "clothing") {
    const rows = (p.sizeChart?.rows || []).filter((r) => r.enabled), cols = (p.colors || []).filter((c) => c.enabled);
    if (rows.length) { if (!rows.some((r) => r.size === item.size)) bad(`Choose a size for ${p.name}.`); size = item.size; }
    if (cols.length) { if (!cols.some((c) => c.name === item.color)) bad(`Choose a colour for ${p.name}.`); color = item.color; }
    if ((p.variants || []).length) {
      variant = p.variants.find((v) => v.size === size && v.color === color);
      if (!variant || !variant.enabled) bad(`${p.name} (${[size, color].filter(Boolean).join(" / ")}) is not available.`);
      if (variant.stock !== null && variant.stock !== undefined && variant.stock < qty) bad(`Only ${variant.stock} left of ${p.name} (${[size, color].filter(Boolean).join(" / ")}).`);
      if (variant.price > 0) unit = variant.price;
      if (variant.sku) sku = variant.sku;
    }
  }
  if (!variant && p.stock !== null && p.stock !== undefined && p.stock < qty) bad(p.stock ? `Only ${p.stock} left of ${p.name}.` : `${p.name} is out of stock.`);
  let total, label = "";
  const d = p.deal || {};
  if (d.kind === "percent" && d.value > 0) { total = Math.round(unit * qty * (1 - d.value / 100)); label = d.label || `${d.value}% off`; }
  else if (d.kind === "bogo") { total = unit * (qty - Math.floor(qty / 2)); label = d.label || "Buy 1 Get 1 Free"; }
  else { total = unit * qty; if (d.kind === "combo") label = d.label || "Combo deal"; }
  return { line: { product: p._id, name: p.name, price: Math.round((total / qty) * 100) / 100, qty, image: p.images?.[0] || "", lineTotal: total, size, color, sku, addons, deal: label },
    take: { product: p._id, size, color, qty, hasVariant: !!variant, tracked: variant ? variant.stock !== null && variant.stock !== undefined : p.stock !== null && p.stock !== undefined } };
}

// Takes (sign = -1) or returns (sign = +1) stock. Each take is a conditional update, so two buyers can never both get the last unit.
async function moveStock(takes, sign) {
  const done = [];
  try {
    for (const t of takes.filter((x) => x.tracked)) {
      if (sign < 0) {
        const r = t.hasVariant
          ? await Product.updateOne({ _id: t.product, variants: { $elemMatch: { size: t.size, color: t.color, stock: { $gte: t.qty } } } }, { $inc: { "variants.$.stock": -t.qty } })
          : await Product.updateOne({ _id: t.product, stock: { $gte: t.qty } }, { $inc: { stock: -t.qty } });
        if (!r.modifiedCount) throw U.fail(409, "Someone just bought the last items. Please review your cart.");
      } else if (t.hasVariant) await Product.updateOne({ _id: t.product, variants: { $elemMatch: { size: t.size, color: t.color } } }, { $inc: { "variants.$.stock": t.qty } });
      else await Product.updateOne({ _id: t.product }, { $inc: { stock: t.qty } });
      done.push(t);
    }
  } catch (e) { if (sign < 0) await moveStock(done, +1); throw e; }
}
const takesOf = (items) => (items || []).filter((i) => i.product).map((i) => ({ product: i.product, size: i.size || "", color: i.color || "", qty: i.qty, hasVariant: false, tracked: false }));
// Re-reads the products of an order to know which of its lines were tracked (used when an order is cancelled).
async function restockOrder(order) {
  const ps = await Product.find({ _id: { $in: order.items.map((i) => i.product).filter(Boolean) } }).select("stock variants").lean();
  const map = new Map(ps.map((p) => [String(p._id), p])), takes = [];
  for (const i of order.items) {
    const p = map.get(String(i.product)); if (!p) continue;
    const v = (p.variants || []).find((x) => x.size === (i.size || "") && x.color === (i.color || ""));
    if (v && v.stock !== null && v.stock !== undefined) takes.push({ product: i.product, size: i.size || "", color: i.color || "", qty: i.qty, hasVariant: true, tracked: true });
    else if (!v && p.stock !== null && p.stock !== undefined) takes.push({ product: i.product, size: "", color: "", qty: i.qty, hasVariant: false, tracked: true });
  }
  await moveStock(takes, +1);
}

// ---- service booking slots ----------------------------------------------------------------------------------------------------------
const TZ_HOURS = Number(process.env.STORE_TZ_HOURS || 5);              // Pakistan = UTC+5
const localNow = () => new Date(Date.now() + TZ_HOURS * 3600e3);
const pad = (n) => String(n).padStart(2, "0");
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); return m ? Math.min(1439, +m[1] * 60 + +m[2]) : null; };
const DEFAULT_DAYS = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, open: d !== 0, from: "10:00", to: "18:00" }));

function cleanAvailability(a = {}) {
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const x = (a.days || []).find((y) => Number(y.day) === d) || DEFAULT_DAYS[d];
    let from = hm(x.from), to = hm(x.to); if (from === null) from = 600; if (to === null) to = 1080; if (to <= from) to = Math.min(1439, from + 60);
    return { day: d, open: !!x.open, from: `${pad(Math.floor(from / 60))}:${pad(from % 60)}`, to: `${pad(Math.floor(to / 60))}:${pad(to % 60)}` };
  });
  return { days, slotMinutes: Math.min(480, Math.max(15, parseInt(a.slotMinutes) || 60)), capacity: Math.min(50, Math.max(1, parseInt(a.capacity) || 1)), leadHours: Math.min(720, Math.max(0, parseInt(a.leadHours) || 0)) };
}
// Free slots of one day. A slot is full when `capacity` active bookings already use that time.
async function slotsFor(store, dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw U.fail(400, "Choose a valid date.");
  const av = cleanAvailability(store.availability?.toObject ? store.availability.toObject() : store.availability);
  const d = new Date(dateStr + "T00:00:00Z"); if (isNaN(d)) throw U.fail(400, "Choose a valid date.");
  const day = av.days[d.getUTCDay()];
  if (!day.open) return { open: false, slots: [] };
  const used = await Booking.aggregate([{ $match: { store: store._id, date: dateStr, type: "booking", status: { $in: ["pending", "confirmed"] } } }, { $group: { _id: "$time", n: { $sum: 1 } } }]);
  const um = Object.fromEntries(used.map((x) => [x._id, x.n]));
  const earliest = +localNow() + av.leadHours * 3600e3, slots = [];
  for (let t = hm(day.from); t + av.slotMinutes <= hm(day.to); t += av.slotMinutes) {
    const time = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
    const at = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), Math.floor(t / 60), t % 60);
    slots.push({ time, available: at >= earliest && (um[time] || 0) < av.capacity });
  }
  return { open: true, slots };
}
module.exports = { CATEGORIES, cleanOptions, publicProduct, priceLine, moveStock, restockOrder, takesOf, slotsFor, cleanAvailability, localNow, DEFAULT_DAYS };
