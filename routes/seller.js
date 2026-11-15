const r = require("express").Router();
const { Store, Product, Order, Booking, SubRequest, Chat } = require("../models");
const { protect, allowRoles, wrap, liveOnly, upload } = require("../guards");
const C = require("../cloud");
const U = require("../utils");
const Plans = require("../plans");
const Shop = require("../shop");
const Subs = require("../subs");

r.use(protect, allowRoles("seller"), wrap(async (req, res, next) => {
  req.store = await Store.findOne({ owner: req.user._id });
  if (!req.store) throw U.fail(404, "No store is linked to this account.");
  next();
}));

const view = (s) => {
  const o = s.toObject(); o.live = s.isLive();
  o.daysLeft = s.subscription?.endsAt ? Math.ceil((s.subscription.endsAt - Date.now()) / U.DAY) : null;
  return o;
};
const num = (v) => U.money(v);
const pickPay = (src = {}, cur) => {
  const out = {};
  for (const m of ["bank", "jazzcash", "easypaisa", "cod"]) {
    const x = src[m] || {};
    out[m] = { enabled: !!x.enabled, bankName: String(x.bankName || "").slice(0, 80), title: String(x.title || "").slice(0, 80), number: String(x.number || "").slice(0, 60), iban: String(x.iban || "").slice(0, 60),
      fee: m === "cod" ? Math.round(U.money(x.fee, 100000)) : 0 };   // cash-on-delivery fee (Rs) the customer pays on top of the total
    if (m !== "cod" && out[m].enabled && !out[m].number) throw U.fail(400, `Enter the account/number for ${m}, or turn it off.`);
  }
  return out;
};

r.get("/store", (req, res) => res.json({ store: view(req.store) }));

r.put("/store", wrap(async (req, res) => {
  const b = req.body, s = req.store;
  const name = String(b.name || "").trim(); if (name.length < 2) throw U.fail(400, "Enter your store name.");
  if (b.themeColor && !/^#[0-9a-fA-F]{6}$/.test(b.themeColor)) throw U.fail(400, "Invalid theme colour.");
  const cat = String(b.category || "").toLowerCase();
  if (cat && cat !== s.category) {
    if (!Shop.CATEGORIES.includes(cat)) throw U.fail(400, "Choose a valid business category.");
    if (s.category && (await Product.exists({ store: s._id }))) throw U.fail(400, "Delete your products first, or ask Orderistan support to change your business category.");
    s.category = cat;
  }
  if (b.availability && typeof b.availability === "object") s.availability = Shop.cleanAvailability(b.availability);
  Object.assign(s, {
    name, tagline: String(b.tagline || "").slice(0, 160), description: String(b.description || "").slice(0, 2000),
    phone: String(b.phone || "").slice(0, 30), whatsapp: String(b.whatsapp || "").slice(0, 30),
    address: String(b.address || "").slice(0, 300), city: String(b.city || "").slice(0, 60),
    themeColor: b.themeColor || s.themeColor, deliveryFee: num(b.deliveryFee), freeDeliveryOver: num(b.freeDeliveryOver),
    payment: pickPay(b.payment)
  });
  await s.save(); U.bg(U.log(req, "seller.store_update", {}, { store: s._id }));
  res.json({ store: view(s) });
}));

r.post("/store/images", upload.fields([{ name: "logo", maxCount: 1 }, { name: "banner", maxCount: 1 }]), wrap(async (req, res) => {
  const s = req.store;
  for (const k of ["logo", "banner"]) {
    const f = req.files?.[k]?.[0]; if (!f) continue;
    const url = await C.uploadPublic(f); C.removePublic(s[k]); s[k] = url;
  }
  await s.save(); res.json({ store: view(s) });
}));

r.get("/stats", wrap(async (req, res) => {
  const sid = req.store._id;
  const [usage, bookingsPending, bookingsToday, products, orders, toVerify, newOrders, rev, recent] = await Promise.all([
    Plans.usageOf(req.store), Booking.countDocuments({ store: sid, status: "pending" }),
    Booking.countDocuments({ store: sid, date: Shop.localNow().toISOString().slice(0, 10), status: { $in: ["pending", "confirmed"] } }),
    Product.countDocuments({ store: sid }), Order.countDocuments({ store: sid }),
    Order.countDocuments({ store: sid, paymentStatus: "submitted" }), Order.countDocuments({ store: sid, status: "pending" }),
    Order.aggregate([{ $match: { store: sid, status: "delivered" } }, { $group: { _id: null, t: { $sum: "$total" } } }]),
    Order.find({ store: sid }).sort({ createdAt: -1 }).limit(6).lean()
  ]);
  res.json({ products, orders, toVerify, newOrders, revenue: rev[0]?.t || 0, recent: recent.map(U.orderView), usage, bookingsPending, bookingsToday, store: view(req.store) });
}));

// ---- products
const productBody = (b) => {
  const name = String(b.name || "").trim().slice(0, 120); const price = Number(b.price);
  if (name.length < 2) throw U.fail(400, "Enter a product name.");
  if (String(b.price ?? "").trim() === "" || !Number.isFinite(price) || price < 0 || price > 1e8) throw U.fail(400, "Enter a valid price.");
  return { name, price, description: String(b.description || "").slice(0, 3000), comparePrice: num(b.comparePrice),
    category: String(b.category || "General").trim().slice(0, 40) || "General",
    inStock: b.inStock !== "false" && b.inStock !== false, active: b.active !== "false" && b.active !== false };
};
r.get("/products", wrap(async (req, res) => {
  const f = { store: req.store._id };
  if (req.query.q) f.name = new RegExp(U.esc(U.qs(req.query.q)), "i"); // limited to this one store, so a scan is cheap
  res.json(await U.paged(Product, f, { page: req.query.page, limit: 30 }));
}));
const imgUpload = upload.fields([{ name: "images", maxCount: 8 }, { name: "colorImages", maxCount: 12 }]);
const parseOptions = (req) => { let o = {}; try { o = JSON.parse(req.body.options || "{}"); } catch { throw U.fail(400, "Product options could not be read."); } return Shop.cleanOptions(req.store.category, o); };

r.post("/products", imgUpload, wrap(async (req, res) => {
  const body = productBody(req.body), opt = parseOptions(req); if (opt.stock === 0) body.inStock = false; // validate first, so a bad form never costs an upload
  const use = await Plans.usageOf(req.store);
  if (use.products >= use.productCap) throw U.fail(403, `Your ${use.plan.name} plan allows ${use.productCap} ${req.store.category === "services" ? "services" : "products"}. Upgrade your plan to add more.`);
  const gal = req.files?.images || [], cfiles = req.files?.colorImages || [];
  const colors = (opt.colors || []).map((c) => ({ ...c, image: "" }));
  const needFiles = colors.filter((c) => c._new).length;
  if (needFiles !== cfiles.length) throw U.fail(400, "Colour photos did not match the colours. Please try again.");
  if (gal.length + cfiles.length > use.plan.maxImages) throw U.fail(403, `Your ${use.plan.name} plan allows ${use.plan.maxImages} images per item (gallery + colour photos).`);
  const images = await C.uploadManyPublic(gal), cimgs = await C.uploadManyPublic(cfiles).catch((e) => { images.forEach(C.removePublic); throw e; });
  let k = 0; for (const c of colors) { if (c._new) c.image = cimgs[k++]; delete c._new; }
  let p;
  try { p = await Product.create({ ...body, ...opt, ...(opt.colors ? { colors } : {}), store: req.store._id, live: req.store.isLive(), images }); }
  catch (e) { [...images, ...cimgs].forEach(C.removePublic); throw e; }
  U.bg(U.log(req, "product.create", { name: p.name }, { store: req.store._id })); res.status(201).json({ product: p });
}));
r.put("/products/:id", imgUpload, wrap(async (req, res) => {
  const p = await Product.findOne({ _id: req.params.id, store: req.store._id });
  if (!p) throw U.fail(404, "Product not found.");
  let keep; try { keep = JSON.parse(req.body.keepImages || "[]"); } catch { keep = []; }
  if (!Array.isArray(keep)) keep = [];
  keep = p.images.filter((i) => keep.includes(i));
  const body = productBody(req.body), opt = req.body.options !== undefined ? parseOptions(req) : {}; if (opt.stock === 0) body.inStock = false;
  const dropped = p.images.filter((i) => !keep.includes(i));
  const use = await Plans.usageOf(req.store), gal = req.files?.images || [], cfiles = req.files?.colorImages || [];
  let colors = null, oldColorImgs = (p.colors || []).map((c) => c.image).filter(Boolean);
  if (opt.colors) {
    const own = new Set(oldColorImgs);   // an existing colour photo may only be kept if this product already owned it
    colors = opt.colors.map((c) => ({ ...c, image: own.has(c.image) ? c.image : "" }));
    if (colors.filter((c) => c._new).length !== cfiles.length) throw U.fail(400, "Colour photos did not match the colours. Please try again.");
  }
  const colorCount = colors ? colors.filter((c) => c.image || c._new).length : oldColorImgs.length;
  if (keep.length + gal.length + colorCount > use.plan.maxImages) throw U.fail(403, `Your ${use.plan.name} plan allows ${use.plan.maxImages} images per item (gallery + colour photos).`);
  const added = await C.uploadManyPublic(gal), cadded = await C.uploadManyPublic(cfiles).catch((e) => { added.forEach(C.removePublic); throw e; });
  if (colors) { let k = 0; for (const c of colors) { if (c._new) c.image = cadded[k++]; delete c._new; } }
  Object.assign(p, body, opt, colors ? { colors } : {}, { images: [...keep, ...added] });
  try { await p.save(); } catch (e) { [...added, ...cadded].forEach(C.removePublic); throw e; }
  dropped.forEach(C.removePublic);
  if (colors) { const now = new Set(colors.map((c) => c.image)); oldColorImgs.filter((i) => !now.has(i)).forEach(C.removePublic); }
  res.json({ product: p });
}));
r.delete("/products/:id", wrap(async (req, res) => {
  const p = await Product.findOneAndDelete({ _id: req.params.id, store: req.store._id });
  if (!p) throw U.fail(404, "Product not found.");
  [...p.images, ...(p.colors || []).map((c) => c.image)].forEach(C.removePublic);
  U.bg(U.log(req, "product.delete", { name: p.name }, { store: req.store._id })); res.json({ ok: true });
}));

// ---- orders
r.get("/orders", wrap(async (req, res) => {
  const f = { store: req.store._id };
  if (req.query.status) f.status = U.qs(req.query.status, 30);
  if (req.query.paymentStatus) f.paymentStatus = U.qs(req.query.paymentStatus, 30);
  if (req.query.q) { const rx = new RegExp(U.esc(U.qs(req.query.q, 40)), "i"); f.$or = [{ orderNo: rx }, { "info.name": rx }, { "info.phone": rx }]; }
  res.json(U.ordersView(await U.paged(Order, f, { page: req.query.page, limit: 20 })));
}));
r.get("/orders/:id", wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, store: req.store._id }).populate("customer", "name phone").lean();
  if (!o) throw U.fail(404, "Order not found."); res.json({ order: U.orderView(o) });
}));

const STATUSES = ["confirmed", "preparing", "out_for_delivery", "delivered", "cancelled"];
r.patch("/orders/:id", liveOnly, wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, store: req.store._id });
  if (!o) throw U.fail(404, "Order not found.");
  const action = String(req.body.action || ""), note = String(req.body.note || "").slice(0, 300);
  let deliveredNow = false, cancelledNow = false, notice = null;
  if (action === "verify") {
    if (o.paymentStatus !== "submitted") throw U.fail(400, "There is no payment waiting for verification.");
    o.paymentStatus = "verified"; o.paymentNote = ""; if (o.status === "pending") o.status = "confirmed";
    o.history.push({ status: o.status, note: "Payment verified" });
    notice = ["Payment verified", `Your payment for ${o.orderNo} is confirmed. We are preparing your order.`];
  } else if (action === "reject") {
    if (o.paymentStatus !== "submitted") throw U.fail(400, "There is no payment waiting for verification.");
    o.paymentStatus = "rejected"; o.paymentNote = note || "Payment could not be verified.";
    o.history.push({ status: o.status, note: "Payment rejected: " + o.paymentNote });
    notice = ["Payment not verified", `${o.orderNo}: ${o.paymentNote} Please upload a correct screenshot.`];
  } else if (action === "status") {
    const st = String(req.body.status || "");
    if (!STATUSES.includes(st)) throw U.fail(400, "Invalid status.");
    if (["delivered", "cancelled"].includes(o.status)) throw U.fail(400, "This order is already closed.");
    if (st !== "cancelled" && !["verified", "cod"].includes(o.paymentStatus)) throw U.fail(400, "Verify the payment before processing this order.");
    o.status = st; o.history.push({ status: st, note }); cancelledNow = st === "cancelled";
    notice = ["Order update", `${o.orderNo} is now ${st.replace(/_/g, " ")}.`];
    deliveredNow = st === "delivered";
  } else throw U.fail(400, "Unknown action.");
  await o.save();   // throws VersionError (409) if someone changed this order since we read it
  if (cancelledNow) U.bg(Shop.restockOrder(o));
  if (notice) U.bg(U.notify(o.customer, notice[0], notice[1], "store:/orders"));
  // "sold" counts units (qty), and only after the order was really saved as delivered
  if (deliveredNow) U.bg(Product.bulkWrite(o.items.filter((i) => i.product).map((i) => ({ updateOne: { filter: { _id: i.product }, update: { $inc: { sold: i.qty || 1 } } } }))));
  U.bg(U.log(req, "order." + action, { orderNo: o.orderNo, status: o.status, payment: o.paymentStatus }, { store: req.store._id }));
  res.json({ order: U.orderView(o) });
}));

r.get("/categories", wrap(async (req, res) => res.json({ items: (await Product.distinct("category", { store: req.store._id })).filter(Boolean).sort() })));

// ---- plan usage (products + images against the subscription plan)
r.get("/usage", wrap(async (req, res) => res.json(await Plans.usageOf(req.store))));
r.get("/plans", wrap(async (_req, res) => res.json({ items: (await Plans.all()).filter((p) => p.active) })));

// ---- subscription: plans, renewal / upgrade requests with payment proof (the admin approves them in Admin > Renewals) -----------------
const reqView = (x) => { const { proof, ...o } = x.toObject ? x.toObject() : x; return { ...o, hasProof: !!proof }; };
r.get("/subscription", wrap(async (req, res) => {
  const [usage, plans, pay, fp, pending, history] = await Promise.all([
    Plans.usageOf(req.store), Plans.all(), Subs.getPay(), Subs.footprint(req.store),
    SubRequest.findOne({ store: req.store._id, status: "pending" }).lean(),
    SubRequest.find({ store: req.store._id }).sort({ createdAt: -1 }).limit(20).lean()
  ]);
  const chat = await Chat.findOne({ store: req.store._id }).select("sellerUnread").lean();
  const pp = Subs.publicPay(pay);
  res.json({ store: view(req.store), usage, footprint: fp, plans: plans.filter((p) => p.active),
    months: Object.entries(Subs.MONTHS).map(([m, days]) => ({ months: Number(m), days, discount: Number(m) === 1 ? 0 : pp.discounts[m] || 0 })),
    pay: { methods: pp.methods, instructions: pp.instructions }, pending: pending ? reqView(pending) : null, history: history.map(reqView), chatUnread: chat?.sellerUnread || 0 });
}));

r.post("/subscription/requests", upload.single("screenshot"), wrap(async (req, res) => {
  const s = req.store, b = req.body;
  if (await SubRequest.exists({ store: s._id, status: "pending" })) throw U.fail(409, "You already have a request waiting for the admin. Wait for the answer or cancel it first.");
  const pay = await Subs.getPay();
  const q = await Subs.quote(b.plan, b.months, pay);
  const method = String(b.method || "");
  // When the owner has published payment accounts, the seller must pick one of them and upload the screenshot.
  // When no account is published yet, the seller can still send the request (any method) and the admin shares the details in chat.
  const anyPay = Subs.METHODS.some((m) => pay[m].enabled);
  if (!Subs.METHODS.includes(method) || (anyPay && !pay[method].enabled)) throw U.fail(400, "Choose a payment method from the list.");
  if (anyPay && !req.file) throw U.fail(400, "Upload the screenshot of your payment.");
  const err = await Subs.fitError(s, q.plan); if (err) throw U.fail(400, err);
  const kind = await Subs.kindOf(s, q.plan);
  const proof = req.file ? await C.uploadPrivate(req.file, "subs") : "";
  let doc;
  try {
    doc = await SubRequest.create({ store: s._id, owner: req.user._id, plan: q.plan.name, planPrice: q.plan.price, months: q.months, days: q.days, discount: q.discount, amount: q.amount, kind,
      method, reference: String(b.reference || "").trim().slice(0, 60), note: String(b.note || "").trim().slice(0, 300), proof });
  } catch (e) { if (proof) C.removePrivate(proof); if (e.code === 11000) throw U.fail(409, "You already have a request waiting for the admin."); throw e; }
  const label = { activate: "Activation", renew: "Renewal", upgrade: "Upgrade", downgrade: "Plan change" }[kind];
  U.bg(U.notifyAdmins(`${label} request: ${s.name}`, `${q.plan.name} x ${q.months} month(s) - Rs ${q.amount} via ${method}. ${proof ? "Verify the payment and approve." : "No screenshot yet - share the payment details in chat, then approve."}`, "/admin/renewals"));
  U.bg(U.log(req, "subscription.request", { plan: q.plan.name, months: q.months, amount: q.amount, kind }, { store: s._id }));
  res.status(201).json({ request: reqView(doc) });
}));

r.delete("/subscription/requests/:id", wrap(async (req, res) => {
  const x = await SubRequest.findOneAndUpdate({ _id: req.params.id, store: req.store._id, status: "pending" }, { status: "cancelled", proof: "" }, { new: false });
  if (!x) throw U.fail(404, "No waiting request found. It may already have been answered.");
  C.removePrivate(x.proof); U.bg(U.log(req, "subscription.request_cancel", { plan: x.plan }, { store: req.store._id }));
  res.json({ ok: true });
}));

// ---- customers (everyone who ordered or booked at this store)
r.get("/customers", wrap(async (req, res) => {
  const sid = req.store._id, q = U.qs(req.query.q, 40).toLowerCase();
  const [o, b] = await Promise.all([
    Order.aggregate([{ $match: { store: sid, status: { $ne: "cancelled" } } }, { $group: { _id: "$customer", orders: { $sum: 1 }, spent: { $sum: "$total" }, last: { $max: "$createdAt" }, name: { $last: "$info.name" }, phone: { $last: "$info.phone" } } }]),
    Booking.aggregate([{ $match: { store: sid, status: { $nin: ["cancelled", "rejected"] } } }, { $group: { _id: "$customer", bookings: { $sum: 1 }, last: { $max: "$createdAt" }, name: { $last: "$info.name" }, phone: { $last: "$info.phone" } } }])
  ]);
  const map = new Map();
  for (const x of o) map.set(String(x._id), { id: x._id, name: x.name, phone: x.phone, orders: x.orders, spent: x.spent, bookings: 0, last: x.last });
  for (const x of b) { const m = map.get(String(x._id)) || { id: x._id, name: x.name, phone: x.phone, orders: 0, spent: 0, bookings: 0, last: x.last }; m.bookings = x.bookings; if (x.last > m.last) m.last = x.last; map.set(String(x._id), m); }
  let items = [...map.values()].sort((a, b2) => +new Date(b2.last) - +new Date(a.last));
  if (q) items = items.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.phone || "").includes(q));
  res.json({ items: items.slice(0, 300), total: items.length });
}));

// ---- sales analytics
r.get("/analytics", wrap(async (req, res) => {
  const sid = req.store._id, days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = new Date(Date.now() - (days - 1) * U.DAY); since.setHours(0, 0, 0, 0);
  const live = { store: sid, status: { $ne: "cancelled" } };
  const [series, byStatus, top, totals, byMethod] = await Promise.all([
    Order.aggregate([{ $match: { ...live, createdAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, orders: { $sum: 1 }, revenue: { $sum: "$total" } } }]),
    Order.aggregate([{ $match: { store: sid } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { ...live, createdAt: { $gte: since } } }, { $unwind: "$items" }, { $group: { _id: "$items.product", name: { $first: "$items.name" }, qty: { $sum: "$items.qty" }, revenue: { $sum: { $ifNull: ["$items.lineTotal", { $multiply: ["$items.price", "$items.qty"] }] } } } }, { $sort: { revenue: -1 } }, { $limit: 8 }]),
    Order.aggregate([{ $match: { ...live, createdAt: { $gte: since } } }, { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: "$total" } } }]),
    Order.aggregate([{ $match: { ...live, createdAt: { $gte: since } } }, { $group: { _id: "$paymentMethod", n: { $sum: 1 }, revenue: { $sum: "$total" } } }])
  ]);
  const m = Object.fromEntries(series.map((x) => [x._id, x]));
  const out = Array.from({ length: days }, (_, i) => { const d = new Date(+since + i * U.DAY).toISOString().slice(0, 10); return { day: d, orders: m[d]?.orders || 0, revenue: m[d]?.revenue || 0 }; });
  const t = totals[0] || { orders: 0, revenue: 0 };
  res.json({ days, series: out, byStatus: Object.fromEntries(byStatus.map((x) => [x._id, x.n])), top, byMethod, orders: t.orders, revenue: t.revenue, avgOrder: t.orders ? Math.round(t.revenue / t.orders) : 0 });
}));

// ---- image management
r.get("/images", wrap(async (req, res) => {
  const ps = await Product.find({ store: req.store._id }).select("name images colors").lean(), items = [];
  for (const p of ps) {
    (p.images || []).forEach((url) => items.push({ url, product: p._id, name: p.name, kind: "gallery" }));
    (p.colors || []).filter((c) => c.image).forEach((c) => items.push({ url: c.image, product: p._id, name: p.name, kind: "color", color: c.name }));
  }
  res.json({ items, usage: await Plans.usageOf(req.store) });
}));
r.delete("/images", wrap(async (req, res) => {
  const p = await Product.findOne({ _id: req.body.product, store: req.store._id });
  if (!p) throw U.fail(404, "Product not found.");
  const url = String(req.body.url || "");
  if (p.images.includes(url)) p.images = p.images.filter((i) => i !== url);
  else { const c = (p.colors || []).find((x) => x.image === url); if (!c) throw U.fail(404, "Image not found."); c.image = ""; }
  await p.save(); C.removePublic(url); res.json({ ok: true });
}));

// ---- bookings & service requests
const bookingView = (b) => b;
r.get("/bookings", wrap(async (req, res) => {
  const f = { store: req.store._id };
  if (req.query.status) f.status = U.qs(req.query.status, 20);
  if (req.query.type) f.type = U.qs(req.query.type, 20);
  if (/^\d{4}-\d{2}-\d{2}$/.test(U.qs(req.query.from, 10)) || /^\d{4}-\d{2}-\d{2}$/.test(U.qs(req.query.to, 10))) {
    f.date = {}; if (/^\d{4}-\d{2}-\d{2}$/.test(U.qs(req.query.from, 10))) f.date.$gte = req.query.from; if (/^\d{4}-\d{2}-\d{2}$/.test(U.qs(req.query.to, 10))) f.date.$lte = req.query.to;
  }
  if (req.query.q) { const rx = new RegExp(U.esc(U.qs(req.query.q, 40)), "i"); f.$or = [{ "info.name": rx }, { "info.phone": rx }, { serviceName: rx }]; }
  const lim = Math.min(300, parseInt(req.query.limit) || 20);
  const sort = req.query.from ? { date: 1, time: 1 } : { createdAt: -1 };
  const data = await U.paged(Booking, f, { page: req.query.page, limit: lim, sort });
  res.json({ ...data, items: data.items.map(bookingView) });
}));
const BOOKING_NEXT = { pending: ["confirmed", "rejected", "cancelled"], confirmed: ["completed", "cancelled"], completed: [], cancelled: [], rejected: [] };
r.patch("/bookings/:id", wrap(async (req, res) => {
  const b = await Booking.findOne({ _id: req.params.id, store: req.store._id });
  if (!b) throw U.fail(404, "Booking not found.");
  const st = String(req.body.status || ""), note = String(req.body.note || "").slice(0, 300);
  if (!(BOOKING_NEXT[b.status] || []).includes(st)) throw U.fail(400, `A ${b.status} ${b.type} cannot be changed to ${st}.`);
  if (b.type === "booking" && st === "confirmed" && b.date) {   // re-check the slot is still free when confirming
    const clash = await Booking.countDocuments({ store: req.store._id, date: b.date, time: b.time, type: "booking", status: "confirmed", _id: { $ne: b._id } });
    if (clash >= (req.store.availability?.capacity || 1)) throw U.fail(409, "That time slot is already fully booked.");
  }
  b.status = st; b.history.push({ status: st, note }); await b.save();
  U.bg(U.notify(b.customer, `${b.type === "request" ? "Request" : "Booking"} ${st}`, `${b.serviceName}${b.date ? " on " + b.date + " " + b.time : ""} is now ${st}.${note ? " " + note : ""}`, "store:/bookings"));
  U.bg(U.log(req, "booking." + st, { service: b.serviceName }, { store: req.store._id }));
  res.json({ booking: b });
}));

module.exports = r;
