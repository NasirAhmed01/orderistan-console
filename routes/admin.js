const r = require("express").Router();
const mongoose = require("mongoose");
const P = require("../password");
const cache = require("../cache");
const { User, Store, Product, Order, Review, Wishlist, Notification, Log, Plan, Booking, Chat, Message, SubRequest, Setting } = require("../models");
const { protect, allowRoles, wrap } = require("../guards");
const C = require("../cloud");
const U = require("../utils");
const jobs = require("../jobs");
const Plans = require("../plans");
const Subs = require("../subs");

r.use(protect, allowRoles("admin"));
const left = (s) => (s.subscription?.endsAt ? Math.ceil((new Date(s.subscription.endsAt) - Date.now()) / U.DAY) : null);
const rx = (q) => new RegExp(U.esc(U.qs(q)), "i");

r.get("/stats", wrap(async (req, res) => {
  const hit = cache.adminStats.get("stats"); if (hit) return res.json(hit);  // dashboard numbers may be up to 60 s old; the aggregates scan every order
  const now = new Date(), soon = new Date(+now + 7 * U.DAY);
  const since = new Date(+now - 13 * U.DAY); since.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [byStatus, customers, orders, ordersToday, awaiting, gmv, series, expiring] = await Promise.all([
    Store.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]), User.countDocuments({ role: "customer" }),
    Order.estimatedDocumentCount(), Order.countDocuments({ createdAt: { $gte: today } }), Order.countDocuments({ paymentStatus: "submitted" }),
    Order.aggregate([{ $match: { status: "delivered" } }, { $group: { _id: null, t: { $sum: "$total" } } }]),
    Order.aggregate([{ $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, n: { $sum: 1 }, total: { $sum: "$total" } } }]),
    Store.find({ status: "active", "subscription.endsAt": { $lte: soon } }).sort({ "subscription.endsAt": 1 }).select("name slug subscription").lean()
  ]);
  const map = Object.fromEntries(series.map((x) => [x._id, x]));
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(+since + i * U.DAY).toISOString().slice(0, 10); return { day: d, n: map[d]?.n || 0, total: map[d]?.total || 0 }; });
  const liveNow = { status: "active", "subscription.endsAt": { $gt: now } };
  const [plans, liveByPlan, cats, imgRow, orderStatus, bookings] = await Promise.all([
    Plans.all(), Store.aggregate([{ $match: liveNow }, { $group: { _id: "$subscription.plan", n: { $sum: 1 } } }]),
    Store.aggregate([{ $group: { _id: { $ifNull: ["$category", ""] }, n: { $sum: 1 } } }]),
    Product.aggregate([{ $group: { _id: null, products: { $sum: 1 }, images: { $sum: { $add: [{ $size: { $ifNull: ["$images", []] } }, { $size: { $filter: { input: { $ifNull: ["$colors", []] }, as: "c", cond: { $gt: [{ $strLenCP: { $ifNull: ["$$c.image", ""] } }, 0] } } } }] } } } }]),
    Order.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]), Booking.estimatedDocumentCount()
  ]);
  const priceOf = (n) => (plans.find((p) => p.name.toLowerCase() === String(n || "").toLowerCase()) || plans[0] || { price: 0 }).price;
  const mrr = liveByPlan.reduce((a, x) => a + priceOf(x._id) * x.n, 0);
  const totalStores = byStatus.reduce((a, x) => a + x.n, 0);
  const out = {
    sellers: totalStores, mrr, categories: Object.fromEntries(cats.map((x) => [x._id || "unset", x.n])), products: imgRow[0]?.products || 0, images: imgRow[0]?.images || 0,
    orderStatus: Object.fromEntries(orderStatus.map((x) => [x._id, x.n])), bookings,
    plans: liveByPlan.map((x) => ({ plan: x._id, n: x.n, price: priceOf(x._id) })),
    stores: Object.fromEntries(byStatus.map((x) => [x._id, x.n])), customers, orders, ordersToday, awaiting, gmv: gmv[0]?.t || 0, days,
    expiring: expiring.map((s) => ({ ...s, daysLeft: left(s) }))
  };
  cache.adminStats.set("stats", out); res.json(out);
}));

// System Overview card: Brevo OTP e-mail counters, MongoDB storage, connection status, last sync. Admin only (r.use above), cached 60 s.
r.get("/system", wrap(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { at, ...out } = await require("../sysmonitor").snapshot({ force: req.query.refresh === "1" });
  res.json(out);
}));

// ---- sellers
r.get("/sellers", wrap(async (req, res) => {
  const f = {};
  const qStatus = U.qs(req.query.status, 20);
  if (qStatus === "expiring") Object.assign(f, { status: "active", "subscription.endsAt": { $lte: new Date(Date.now() + 7 * U.DAY) } });
  else if (qStatus) f.status = qStatus;
  if (req.query.q) f.$or = [{ name: rx(req.query.q) }, { slug: rx(req.query.q) }];
  const qCat = U.qs(req.query.category, 20); if (qCat === "unset") f.category = ""; else if (["food", "clothing", "services"].includes(qCat)) f.category = qCat;
  if (req.query.plan) f["subscription.plan"] = new RegExp("^" + U.esc(U.qs(req.query.plan, 30)) + "$", "i");
  const data = await U.paged(Store, f, { page: req.query.page, populate: [{ path: "owner", select: "name email phone status lastLoginAt" }] });
  const counts = await Order.aggregate([{ $match: { store: { $in: data.items.map((s) => s._id) } } }, { $group: { _id: "$store", n: { $sum: 1 } } }]);
  const cm = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  const use = await Product.aggregate([{ $match: { store: { $in: data.items.map((s) => s._id) } } }, { $group: { _id: "$store", products: { $sum: 1 },
    images: { $sum: { $add: [{ $size: { $ifNull: ["$images", []] } }, { $size: { $filter: { input: { $ifNull: ["$colors", []] }, as: "c", cond: { $gt: [{ $strLenCP: { $ifNull: ["$$c.image", ""] } }, 0] } } } }] } } } }]);
  const um = Object.fromEntries(use.map((x) => [String(x._id), x])), plans = await Plans.all();
  data.items = data.items.map((s) => { const pl = plans.find((p) => p.name.toLowerCase() === String(s.subscription?.plan || "").toLowerCase()) || plans[0];
    return { ...s, daysLeft: left(s), orders: cm[String(s._id)] || 0, products: um[String(s._id)]?.products || 0, images: um[String(s._id)]?.images || 0,
      limits: pl ? { maxProducts: pl.maxProducts, maxImages: pl.maxImages, imageCap: pl.maxProducts * pl.maxImages, price: pl.price } : null }; });
  res.json(data);
}));

r.post("/sellers", wrap(async (req, res) => {
  if (req.body.plan && !(await Plans.all()).some((p) => p.name.toLowerCase() === String(req.body.plan).toLowerCase())) throw U.fail(400, "Unknown plan.");
  const { user, store } = await U.createSeller(req.body);
  await U.log(req, "admin.seller_create", { slug: store.slug }, { store: store._id });
  res.status(201).json({ store, user: U.safeUser(user) });
}));

const planName = async (n) => { const p = (await Plans.all()).find((x) => x.name.toLowerCase() === String(n || "").toLowerCase()); if (!p) throw U.fail(400, "Unknown plan."); return p.name; };
r.patch("/sellers/:id", wrap(async (req, res) => {
  const s = await Store.findById(req.params.id);
  if (!s) throw U.fail(404, "Seller store not found.");
  const action = String(req.body.action || ""), now = new Date();
  if (action === "activate") {
    const wasLive = s.isLive();
    let end;
    if (req.body.endsAt) { end = new Date(req.body.endsAt); if (isNaN(end) || end <= now) throw U.fail(400, "Choose a future end date."); }
    else { const days = Math.min(3650, Math.max(1, parseInt(req.body.days) || 30)); end = new Date(+(wasLive ? s.subscription.endsAt : now) + days * U.DAY); }
    if (!wasLive) s.subscription.startsAt = now;
    s.subscription.endsAt = end; s.subscription.notified = [];
    s.subscription.plan = await planName(req.body.plan || s.subscription.plan || "Basic"); s.status = "active";
    await s.save(); await U.syncLive(s);
    await U.notify(s.owner, "Subscription active", `Your store is active until ${end.toDateString()}.`, "/seller");
    await U.log(req, "subscription.activate", { store: s.slug, until: end, plan: s.subscription.plan }, { store: s._id });
  } else if (action === "deactivate") {
    s.status = "inactive"; await s.save(); await U.syncLive(s);
    await U.notify(s.owner, "Store deactivated", "Your store was deactivated by the administrator. Contact Orderistan for help.", "/seller");
    await U.log(req, "subscription.deactivate", { store: s.slug }, { store: s._id });
  } else if (action === "update") {
    const name = String(req.body.name || s.name).trim(), slug = String(req.body.slug || s.slug).trim().toLowerCase();
    if (slug !== s.slug) {
      if (!U.validSlug(slug)) throw U.fail(400, "Invalid store link.");
      if (await Store.exists({ slug, _id: { $ne: s._id } })) throw U.fail(409, "This store link is already taken.");
    }
    Object.assign(s, { name, slug }); s.subscription.plan = await planName(req.body.plan || s.subscription.plan);
    if (req.body.category !== undefined) { const c = String(req.body.category); if (c && !["food", "clothing", "services"].includes(c)) throw U.fail(400, "Invalid category."); s.category = c; }
    await s.save(); await U.log(req, "admin.seller_update", { store: s.slug }, { store: s._id });
  } else throw U.fail(400, "Unknown action.");
  res.json({ store: s });
}));

r.delete("/sellers/:id", wrap(async (req, res) => {
  const s = await Store.findById(req.params.id);
  if (!s) throw U.fail(404, "Seller store not found.");
  const shots = await Order.find({ store: s._id, paymentScreenshot: { $ne: "" } }).select("paymentScreenshot").lean();
  shots.forEach((o) => C.removePrivate(o.paymentScreenshot));
  [s.logo, s.banner].forEach(C.removePublic);
  const [chatShots, proofs] = await Promise.all([Message.find({ store: s._id, image: { $ne: "" } }).select("image").lean(), SubRequest.find({ store: s._id, proof: { $ne: "" } }).select("proof").lean()]);
  chatShots.forEach((m) => C.removePrivate(m.image)); proofs.forEach((x) => C.removePrivate(x.proof));
  (await Product.find({ store: s._id }).select("images colors").lean()).forEach((p) => [...(p.images || []), ...(p.colors || []).map((c) => c.image)].forEach(C.removePublic));
  await Promise.all([Product.deleteMany({ store: s._id }), Review.deleteMany({ store: s._id }), Wishlist.deleteMany({ store: s._id }),
    Order.deleteMany({ store: s._id }), Booking.deleteMany({ store: s._id }), Message.deleteMany({ store: s._id }), Chat.deleteMany({ store: s._id }), SubRequest.deleteMany({ store: s._id }), Notification.deleteMany({ user: s.owner }), User.deleteOne({ _id: s.owner }), s.deleteOne()]);
  await U.log(req, "admin.seller_delete", { slug: s.slug }); res.json({ ok: true });
}));

// ---- users
r.get("/users", wrap(async (req, res) => {
  const f = {};
  if (req.query.role) f.role = U.qs(req.query.role, 20);
  if (req.query.q) f.$or = [{ name: rx(req.query.q) }, { email: rx(req.query.q) }, { phone: rx(req.query.q) }];
  res.json(await U.paged(User, f, { page: req.query.page }));
}));
r.patch("/users/:id", wrap(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) throw U.fail(404, "User not found.");
  if (u.role === "admin") throw U.fail(400, "The owner account cannot be changed here.");
  if (req.body.status) {
    if (!["active", "suspended"].includes(req.body.status)) throw U.fail(400, "Invalid status.");
    u.status = req.body.status;
    if (u.status === "suspended") u.tokenVersion = (u.tokenVersion || 0) + 1;
    if (u.role === "seller" && u.status === "suspended") {
      await Store.updateOne({ owner: u._id, status: "active" }, { status: "inactive" });
      const st = await Store.findOne({ owner: u._id }); if (st) await U.syncLive(st);   // hide its products from the marketplace right away
    }
  }
  if (req.body.password) {
    if (String(req.body.password).length < 10) throw U.fail(400, "Password must be at least 10 characters.");
    U.checkPassword(req.body.password);
    u.password = await P.hash(String(req.body.password));
    u.tokenVersion = (u.tokenVersion || 0) + 1; u.failedLogins = 0; u.lockUntil = undefined;   // logs the user out everywhere
  }
  await u.save(); await U.log(req, "admin.user_update", { user: u.email, status: u.status });
  res.json({ user: U.safeUser(u) });
}));
r.delete("/users/:id", wrap(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u || u.role !== "customer") throw U.fail(400, "Only customer accounts can be deleted here.");
  await Promise.all([Wishlist.deleteMany({ user: u._id }), Notification.deleteMany({ user: u._id }), u.deleteOne()]);
  await U.log(req, "admin.user_delete", { user: u.email }); res.json({ ok: true });
}));

// ---- all orders (read only)
const orderPop = [{ path: "store", select: "name slug" }, { path: "customer", select: "name email phone" }];
r.get("/orders", wrap(async (req, res) => {
  const f = {};
  if (req.query.store && mongoose.isValidObjectId(req.query.store)) f.store = req.query.store;
  if (req.query.status) f.status = U.qs(req.query.status, 30);
  if (req.query.paymentStatus) f.paymentStatus = U.qs(req.query.paymentStatus, 30);
  if (req.query.q) f.$or = [{ orderNo: rx(req.query.q) }, { "info.name": rx(req.query.q) }, { "info.phone": rx(req.query.q) }];
  res.json(U.ordersView(await U.paged(Order, f, { page: req.query.page, populate: orderPop })));
}));
r.get("/orders/:id", wrap(async (req, res) => {
  const o = await Order.findById(req.params.id).populate(orderPop).lean();
  if (!o) throw U.fail(404, "Order not found."); res.json({ order: U.orderView(o) });
}));

// ---- user activity log
r.get("/logs", wrap(async (req, res) => {
  const f = {};
  if (req.query.action) f.action = new RegExp("^" + U.esc(U.qs(req.query.action, 30)));
  if (req.query.role) f.role = U.qs(req.query.role, 20);
  if (req.query.q) f.$or = [{ actorName: rx(req.query.q) }, { action: rx(req.query.q) }, { ip: rx(req.query.q) }];
  res.json(await U.paged(Log, f, { page: req.query.page, limit: 30, populate: [{ path: "store", select: "name slug" }] }));
}));

r.post("/notify", wrap(async (req, res) => {
  const title = String(req.body.title || "").trim().slice(0, 120), body = String(req.body.body || "").trim().slice(0, 500);
  if (!title) throw U.fail(400, "Enter a title.");
  let owners;
  if (req.body.target === "sellers") owners = await Store.distinct("owner");
  else { const s = await Store.findById(req.body.target); if (!s) throw U.fail(404, "Seller not found."); owners = [s.owner]; }
  await U.notify(owners, title, body, "/seller");
  await U.log(req, "admin.notify", { title, count: owners.length }); res.json({ sent: owners.length });
}));

// ---- subscription plans (price + limits are editable, never hard-coded in the code that enforces them)
r.get("/plans", wrap(async (_req, res) => {
  const [plans, counts] = await Promise.all([Plan.find().sort({ sort: 1, price: 1 }).lean(), Store.aggregate([{ $group: { _id: "$subscription.plan", n: { $sum: 1 }, live: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "active"] }, { $gt: ["$subscription.endsAt", new Date()] }] }, 1, 0] } } } }])]);
  const cm = Object.fromEntries(counts.map((c) => [String(c._id || "").toLowerCase(), c]));
  res.json({ items: plans.map((p) => ({ ...p, stores: cm[p.name.toLowerCase()]?.n || 0, live: cm[p.name.toLowerCase()]?.live || 0 })) });
}));
r.patch("/plans/:id", wrap(async (req, res) => {
  const p = await Plan.findById(req.params.id); if (!p) throw U.fail(404, "Plan not found.");
  const n = (v, lo, hi) => { const x = Math.floor(Number(v)); if (!Number.isFinite(x) || x < lo || x > hi) throw U.fail(400, "Enter valid numbers for the plan."); return x; };
  if (req.body.price !== undefined) p.price = n(req.body.price, 0, 1e7);
  if (req.body.maxProducts !== undefined) p.maxProducts = n(req.body.maxProducts, 1, 5000);
  if (req.body.maxImages !== undefined) p.maxImages = n(req.body.maxImages, 1, 50);
  if (req.body.active !== undefined) p.active = !!req.body.active;
  await p.save(); Plans.bust(); await U.log(req, "admin.plan_update", { plan: p.name, price: p.price, maxProducts: p.maxProducts, maxImages: p.maxImages });
  res.json({ plan: p });
}));

// ---- renewal requests: sellers pay Orderistan, upload the screenshot, the owner verifies it here and the subscription is extended ----------
const reqPop = [{ path: "store", select: "name slug status category subscription" }, { path: "owner", select: "name email phone" }];
const reqOut = (x) => { const { proof, ...o } = x; return { ...o, hasProof: !!proof }; };
r.get("/sub-requests", wrap(async (req, res) => {
  const f = {}, st = U.qs(req.query.status, 12);
  if (["pending", "approved", "rejected", "cancelled"].includes(st)) f.status = st;
  if (req.query.q) f.store = { $in: await Store.distinct("_id", { $or: [{ name: rx(req.query.q) }, { slug: rx(req.query.q) }] }) };
  const data = await U.paged(SubRequest, f, { page: req.query.page, populate: reqPop, sort: st === "pending" ? { createdAt: 1 } : { createdAt: -1 } });
  data.items = data.items.map(reqOut); res.json(data);
}));
r.get("/sub-requests/:id", wrap(async (req, res) => {
  const x = await SubRequest.findById(req.params.id).populate(reqPop).lean();
  if (!x) throw U.fail(404, "Request not found.");
  const store = await Store.findById(x.store?._id); let fit = "", usage = null, current = null;
  if (store) {
    const plan = (await Plans.all()).find((p) => p.name.toLowerCase() === x.plan.toLowerCase());
    fit = plan ? await Subs.fitError(store, plan) : `The ${x.plan} plan no longer exists.`;
    usage = await Plans.usageOf(store); current = { live: store.isLive(), endsAt: store.subscription?.endsAt || null, plan: store.subscription?.plan || "", status: store.status };
  }
  res.json({ request: reqOut(x), fit, usage, current });
}));
r.patch("/sub-requests/:id", wrap(async (req, res) => {
  const action = String(req.body.action || ""), note = String(req.body.note || "").trim().slice(0, 300), now = new Date();
  const x0 = await SubRequest.findById(req.params.id);
  if (!x0) throw U.fail(404, "Request not found.");
  if (x0.status !== "pending") throw U.fail(409, "This request was already answered.");
  const store = await Store.findById(x0.store); if (!store) throw U.fail(404, "Seller store not found.");
  if (action === "approve") {
    // claim the request first, so two quick clicks (or two admins) can never extend the store twice
    const x = await SubRequest.findOneAndUpdate({ _id: x0._id, status: "pending" }, { status: "approved", decidedAt: now, decidedBy: req.user._id, adminNote: note }, { new: true });
    if (!x) throw U.fail(409, "This request was already answered.");
    let out;
    try { out = await Subs.apply(store, x, now); }
    catch (e) { await SubRequest.updateOne({ _id: x._id }, { status: "pending", $unset: { decidedAt: 1, decidedBy: 1 }, adminNote: "" }).catch(() => {}); throw e; }
    await SubRequest.updateOne({ _id: x._id }, { endsAtAfter: out.endsAt });
    await U.notify(store.owner, "Payment confirmed", `${x.plan} plan active until ${out.endsAt.toDateString()}.${note ? " " + note : ""}`, "/seller/subscription");
    await U.log(req, "subscription.request_approve", { store: store.slug, plan: x.plan, months: x.months, amount: x.amount, until: out.endsAt }, { store: store._id });
    cache.adminStats.clear();
    return res.json({ ok: true, endsAt: out.endsAt });
  }
  if (action === "reject") {
    const reason = note || "Payment could not be verified.";
    const x = await SubRequest.findOneAndUpdate({ _id: x0._id, status: "pending" }, { status: "rejected", decidedAt: now, decidedBy: req.user._id, adminNote: reason }, { new: true });
    if (!x) throw U.fail(409, "This request was already answered.");
    await U.notify(store.owner, "Payment not confirmed", `${x.plan} plan request: ${reason} You can submit a new request or chat with the admin.`, "/seller/subscription");
    await U.log(req, "subscription.request_reject", { store: store.slug, plan: x.plan, reason }, { store: store._id });
    return res.json({ ok: true });
  }
  throw U.fail(400, "Unknown action.");
}));

// where sellers send their subscription payments + discounts for 3 / 6 / 12 months
r.get("/payment-settings", wrap(async (_req, res) => res.json({ settings: await Subs.getPay() })));
r.put("/payment-settings", wrap(async (req, res) => {
  const value = Subs.cleanPay(req.body);
  await Setting.updateOne({ _id: "platformPay" }, { value }, { upsert: true });
  await U.log(req, "admin.payment_settings", { methods: Subs.METHODS.filter((m) => value[m].enabled) });
  res.json({ settings: await Subs.getPay() });
}));

// ---- industries
const INDUSTRIES = [["food", "Food & Restaurant"], ["clothing", "Clothing & Fashion"], ["services", "Services"]];
r.get("/industries", wrap(async (_req, res) => {
  const now = new Date();
  const [st, pr, ord] = await Promise.all([
    Store.aggregate([{ $group: { _id: { $ifNull: ["$category", ""] }, sellers: { $sum: 1 }, active: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "active"] }, { $gt: ["$subscription.endsAt", now] }] }, 1, 0] } } } }]),
    Product.aggregate([{ $lookup: { from: "stores", localField: "store", foreignField: "_id", as: "s" } }, { $unwind: "$s" }, { $group: { _id: { $ifNull: ["$s.category", ""] }, products: { $sum: 1 } } }]),
    Order.aggregate([{ $lookup: { from: "stores", localField: "store", foreignField: "_id", as: "s" } }, { $unwind: "$s" }, { $group: { _id: { $ifNull: ["$s.category", ""] }, orders: { $sum: 1 }, revenue: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, "$total", 0] } } } }])
  ]);
  const by = (a, k) => Object.fromEntries(a.map((x) => [x._id, x]));
  const S = by(st), P = by(pr), O = by(ord);
  const row = (key, label) => ({ key, label, sellers: S[key]?.sellers || 0, active: S[key]?.active || 0, products: P[key]?.products || 0, orders: O[key]?.orders || 0, revenue: O[key]?.revenue || 0 });
  res.json({ items: [...INDUSTRIES.map(([k, l]) => row(k, l)), row("", "Not chosen yet")] });
}));

// ---- Cloudinary monitoring: account usage from Cloudinary + the image counts Orderistan knows about
const level = (p) => (p >= 95 ? 95 : p >= 85 ? 85 : p >= 70 ? 70 : 0);
r.get("/cloudinary", wrap(async (req, res) => {
  const [stores, prods, byCat, recent] = await Promise.all([
    Store.aggregate([{ $group: { _id: null, logos: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$logo", ""] } }, 0] }, 1, 0] } }, banners: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$banner", ""] } }, 0] }, 1, 0] } } } }]),
    Product.aggregate([{ $group: { _id: "$store", gallery: { $sum: { $size: { $ifNull: ["$images", []] } } }, color: { $sum: { $size: { $filter: { input: { $ifNull: ["$colors", []] }, as: "c", cond: { $gt: [{ $strLenCP: { $ifNull: ["$$c.image", ""] } }, 0] } } } } } } }, { $sort: { gallery: -1 } }]),
    Product.aggregate([{ $lookup: { from: "stores", localField: "store", foreignField: "_id", as: "s" } }, { $unwind: "$s" }, { $group: { _id: { $ifNull: ["$s.category", ""] }, images: { $sum: { $size: { $ifNull: ["$images", []] } } } } }]),
    Product.aggregate([{ $match: { createdAt: { $gte: new Date(Date.now() - 29 * U.DAY) } } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, images: { $sum: { $size: { $ifNull: ["$images", []] } } } } }])
  ]);
  const gallery = prods.reduce((a, x) => a + x.gallery, 0), color = prods.reduce((a, x) => a + x.color, 0);
  const top = prods.slice(0, 5), names = await Store.find({ _id: { $in: top.map((x) => x._id) } }).select("name slug").lean(), nm = new Map(names.map((x) => [String(x._id), x]));
  const local = { total: gallery + color + (stores[0]?.logos || 0) + (stores[0]?.banners || 0), gallery, color, logos: stores[0]?.logos || 0, banners: stores[0]?.banners || 0,
    byCategory: Object.fromEntries(byCat.map((x) => [x._id || "unset", x.images])),
    topStores: top.map((x) => ({ store: nm.get(String(x._id))?.name || "-", slug: nm.get(String(x._id))?.slug, images: x.gallery + x.color })),
    perDay: (() => { const m = Object.fromEntries(recent.map((x) => [x._id, x.images])); return Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.now() - (29 - i) * U.DAY).toISOString().slice(0, 10); return { day: d, images: m[d] || 0 }; }); })() };
  let cloud = null, error = "";
  try { cloud = await C.usage(req.query.refresh === "1"); } catch (e) { error = "Could not read usage from Cloudinary (" + String(e.message || e).slice(0, 120) + ")."; }
  res.json({ local, cloud, error, level: cloud?.percent != null ? level(cloud.percent) : 0, thresholds: [70, 85, 95] });
}));

r.post("/run-expiry-check", wrap(async (req, res) => res.json(await jobs.checkSubscriptions())));

module.exports = r;
