// Public storefront + customer actions. Every route knows which store it belongs to (subdomain or X-Store-Slug).
const r = require("express").Router();
const mongoose = require("mongoose");
const crypto = require("crypto");
const { Product, Order, Review, Wishlist, Booking, keywordFilter } = require("../models");
const { protect, allowRoles, wrap, tenant, liveOnly, upload } = require("../guards");
const C = require("../cloud");
const U = require("../utils");
const Shop = require("../shop");

r.use(tenant);
const METHODS = ["bank", "jazzcash", "easypaisa", "cod"];
const customer = [protect, allowRoles("customer")];

const publicStore = (s) => ({
  slug: s.slug, name: s.name, tagline: s.tagline, description: s.description, logo: s.logo, banner: s.banner,
  phone: s.phone, whatsapp: s.whatsapp, address: s.address, city: s.city, themeColor: s.themeColor, category: s.category || "",
  availability: s.category === "services" ? Shop.cleanAvailability(s.availability?.toObject ? s.availability.toObject() : s.availability) : undefined,
  deliveryFee: s.deliveryFee, freeDeliveryOver: s.freeDeliveryOver, closed: !s.isLive(),
  codFee: s.payment?.cod?.enabled ? Math.round(Number(s.payment.cod.fee) || 0) : 0,
  methods: METHODS.filter((m) => s.payment?.[m]?.enabled)
});
r.get("/", (req, res) => res.json({ store: publicStore(req.store) }));

r.get("/products", liveOnly, wrap(async (req, res) => {
  const f = { store: req.store._id, active: true };
  const kw = req.query.q && keywordFilter(U.qs(req.query.q)); if (kw) f.keywords = kw;
  if (req.query.category) f.category = U.qs(req.query.category, 40);
  const sort = U.sortBy({ newest: { createdAt: -1 }, price_asc: { price: 1 }, price_desc: { price: -1 }, popular: { sold: -1 } }, req.query.sort, { createdAt: -1 });
  const data = await U.paged(Product, f, { sort, page: req.query.page, limit: req.query.limit || 24 });
  data.items = data.items.map(Shop.publicProduct); res.json(data);
}));
r.get("/categories", liveOnly, wrap(async (req, res) =>
  res.json({ items: await Product.distinct("category", { store: req.store._id, active: true }) })));

r.get("/products/:id", liveOnly, wrap(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, store: req.store._id, active: true }).lean();
  if (!product) throw U.fail(404, "Product not found.");
  const reviews = await Review.find({ product: product._id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ product: Shop.publicProduct(product), reviews });
}));

r.post("/products/:id/reviews", liveOnly, ...customer, wrap(async (req, res) => {
  const p = await Product.findOne({ _id: req.params.id, store: req.store._id, active: true }).select("_id");
  if (!p) throw U.fail(404, "Product not found.");
  const rating = Math.round(Number(req.body.rating));
  if (!(rating >= 1 && rating <= 5)) throw U.fail(400, "Choose a rating from 1 to 5.");
  const verified = !!(await Order.exists({ customer: req.user._id, store: req.store._id, "items.product": p._id, status: "delivered" }));
  await Review.findOneAndUpdate({ product: p._id, user: req.user._id },
    { store: req.store._id, userName: req.user.name, rating, comment: String(req.body.comment || "").trim().slice(0, 1000), verified },
    { upsert: true, new: true, setDefaultsOnInsert: true });
  const agg = await Review.aggregate([{ $match: { product: p._id } }, { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } }]);
  await Product.updateOne({ _id: p._id }, { ratingAvg: Math.round((agg[0]?.avg || 0) * 10) / 10, ratingCount: agg[0]?.n || 0 });
  res.json({ message: "Thanks for your review!" });
}));

r.get("/wishlist", ...customer, wrap(async (req, res) => {
  const rows = await Wishlist.find({ user: req.user._id, store: req.store._id }).populate("product").lean();
  res.json({ items: rows.map((x) => x.product).filter((p) => p && p.active).map(Shop.publicProduct) });
}));
r.post("/wishlist/:productId", liveOnly, ...customer, wrap(async (req, res) => {
  const had = await Wishlist.findOneAndDelete({ user: req.user._id, product: req.params.productId });
  if (!had) {
    if (!(await Product.exists({ _id: req.params.productId, store: req.store._id }))) throw U.fail(404, "Product not found.");
    await Wishlist.create({ user: req.user._id, store: req.store._id, product: req.params.productId });
  }
  res.json({ wished: !had });
}));

// Seller's payment instructions (shown only to logged-in customers at checkout).
r.get("/payment-info", liveOnly, ...customer, wrap(async (req, res) => {
  const p = req.store.payment, out = {};
  for (const m of METHODS) if (p?.[m]?.enabled) out[m] = p[m];
  res.json({ methods: out });
}));

r.post("/orders", liveOnly, ...customer, upload.single("screenshot"), wrap(async (req, res) => {
  const bail = (msg) => { throw U.fail(400, msg); }; // nothing is uploaded until every check has passed
  let items; try { items = JSON.parse(req.body.items); } catch { items = []; }
  if (!Array.isArray(items) || !items.length || items.length > 50) bail("Your cart is empty.");
  items = items.filter((i) => i && typeof i === "object");
  if (!items.length) bail("Your cart is empty.");
  if (req.store.category === "services") bail("This business takes bookings and requests, not cart orders.");
  const ids = items.map((i) => i.product).filter((id) => typeof id === "string" && mongoose.isValidObjectId(id));
  const prods = await Product.find({ _id: { $in: ids }, store: req.store._id, active: true, inStock: true });
  const map = new Map(prods.map((p) => [String(p._id), p]));
  const lines = [], takes = [];
  for (const i of items) {
    const p = map.get(String(i.product));
    if (!p) bail("An item in your cart is no longer available. Please review your cart.");
    const priced = Shop.priceLine(p, req.store, i); lines.push(priced.line); takes.push(priced.take);
  }
  const name = String(req.body.name || "").trim().slice(0, 80), phone = String(req.body.phone || "").trim().slice(0, 30), address = String(req.body.address || "").trim().slice(0, 300);
  if (name.length < 2 || phone.length < 7 || address.length < 6) bail("Enter your name, phone number and full delivery address.");
  const method = String(req.body.paymentMethod || "");
  if (!METHODS.includes(method) || !req.store.payment?.[method]?.enabled) bail("Choose a payment method offered by this store.");
  if (method !== "cod" && !req.file) bail("Upload your payment screenshot to place this order.");

  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  const s = req.store;
  const deliveryFee = s.freeDeliveryOver > 0 && subtotal >= s.freeDeliveryOver ? 0 : s.deliveryFee;
  // cash on delivery: the store's own handling fee (Rs 50, 100 ...) is added to the total. It is read from the store here, never from the browser.
  const codFee = method === "cod" ? Math.round(U.money(s.payment?.cod?.fee, 100000)) : 0;
  await Shop.moveStock(takes, -1);   // reserve stock first (all or nothing), so a sold-out cart never costs an image upload
  let shot = "";
  if (method !== "cod") { try { shot = await C.uploadPrivate(req.file); } catch (e) { await Shop.moveStock(takes, +1).catch(() => {}); throw e; } }
  let order;
  try { order = await Order.create({
    orderNo: "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString("hex").toUpperCase(),
    store: s._id, customer: req.user._id, items: lines, subtotal, deliveryFee, codFee, total: subtotal + deliveryFee + codFee,
    info: { name, phone, address, note: String(req.body.note || "").slice(0, 300) }, paymentMethod: method,
    paymentScreenshot: shot,
    paymentStatus: method === "cod" ? "cod" : "submitted", history: [{ status: "pending", note: "Order placed" }]
  }); } catch (e) { C.removePrivate(shot); await Shop.moveStock(takes, +1).catch(() => {}); throw e; }
  // the customer gets the answer now; the seller notification and activity log are written in the background
  U.bg(U.notify(s.owner, "New order " + order.orderNo, `Rs ${order.total} - ${method === "cod" ? "Cash on delivery" + (codFee ? ` (incl. Rs ${codFee} COD fee)` : "") : "payment screenshot waiting for verification"}`, "/seller/orders"));
  U.bg(U.log(req, "order.placed", { orderNo: order.orderNo, total: order.total, method }, { store: s._id }));
  res.status(201).json({ order: U.orderView(order) });
}));

r.get("/orders", ...customer, wrap(async (req, res) =>
  res.json({ items: (await Order.find({ customer: req.user._id, store: req.store._id }).sort({ createdAt: -1 }).limit(100).lean()).map(U.orderView) })));

r.post("/orders/:id/screenshot", ...customer, upload.single("screenshot"), wrap(async (req, res) => {
  if (!req.file) throw U.fail(400, "Choose a screenshot to upload.");
  const o = await Order.findOne({ _id: req.params.id, customer: req.user._id, store: req.store._id });
  if (!o || !["unpaid", "rejected"].includes(o.paymentStatus) || ["cancelled", "delivered"].includes(o.status)) {
    throw U.fail(400, "A screenshot cannot be uploaded for this order.");
  }
  const old = o.paymentScreenshot, fresh = await C.uploadPrivate(req.file);
  o.paymentScreenshot = fresh; o.paymentStatus = "submitted"; o.paymentNote = "";
  o.history.push({ status: o.status, note: "New payment screenshot uploaded" });
  try { await o.save(); } catch (e) { C.removePrivate(fresh); throw e; }   // lost a race (VersionError)? do not leave an orphan upload
  C.removePrivate(old);
  U.bg(U.notify(req.store.owner, "Payment screenshot uploaded", `${o.orderNo} is waiting for verification.`, "/seller/orders"));
  U.bg(U.log(req, "order.screenshot", { orderNo: o.orderNo }, { store: req.store._id }));
  res.json({ order: U.orderView(o) });
}));

r.post("/orders/:id/cancel", ...customer, wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, customer: req.user._id, store: req.store._id });
  if (!o) throw U.fail(404, "Order not found.");
  if (o.status !== "pending" || o.paymentStatus === "verified") throw U.fail(400, "This order can no longer be cancelled. Please contact the seller.");
  o.status = "cancelled"; o.history.push({ status: "cancelled", note: "Cancelled by customer" }); await o.save(); U.bg(Shop.restockOrder(o));
  U.bg(U.notify(req.store.owner, "Order cancelled", `${o.orderNo} was cancelled by the customer.`, "/seller/orders"));
  U.bg(U.log(req, "order.cancelled", { orderNo: o.orderNo }, { store: req.store._id }));
  res.json({ order: U.orderView(o) });
}));

// ---- services: free time slots, bookings and service requests ------------------------------------------------------------------
r.get("/availability", liveOnly, wrap(async (req, res) => {
  if (req.store.category !== "services") throw U.fail(400, "This store does not take bookings.");
  res.json(await Shop.slotsFor(req.store, U.qs(req.query.date, 10)));
}));

r.post("/bookings", liveOnly, ...customer, wrap(async (req, res) => {
  const s = req.store, b = req.body;
  if (s.category !== "services") throw U.fail(400, "This store does not take bookings.");
  const p = mongoose.isValidObjectId(b.product) && await Product.findOne({ _id: b.product, store: s._id, active: true, inStock: true });
  if (!p) throw U.fail(404, "This service is no longer available.");
  const name = String(b.name || "").trim().slice(0, 80), phone = String(b.phone || "").trim().slice(0, 30);
  if (name.length < 2 || phone.length < 7) throw U.fail(400, "Enter your name and phone number.");
  const pk = String(b.package || "");
  const pack = (p.packages || []).filter((x) => x.enabled);
  const chosen = pack.length ? pack.find((x) => x.name === pk) : null;
  if (pack.length && !chosen) throw U.fail(400, "Choose a package.");
  const addons = [].concat(b.addons || []).map(String), picked = [];
  let price = chosen ? chosen.price : p.price;
  for (const n of [...new Set(addons)].slice(0, 10)) { const a = (p.addons || []).find((x) => x.enabled && x.name === n); if (!a) throw U.fail(400, `"${n}" is no longer available.`); picked.push(a.name); price += a.price; }
  const type = p.bookingMode === "request" ? "request" : "booking";
  let date = "", time = "";
  if (type === "booking") {
    date = String(b.date || ""); time = String(b.time || "");
    const day = await Shop.slotsFor(s, date);
    if (!day.slots.some((x) => x.time === time && x.available)) throw U.fail(409, "That time was just taken. Please pick another slot.");
    const cap = s.availability?.capacity || 1;
    const used = await Booking.countDocuments({ store: s._id, date, time, type: "booking", status: { $in: ["pending", "confirmed"] } });
    if (used >= cap) throw U.fail(409, "That time was just taken. Please pick another slot.");
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ""))) date = String(b.date);
  const doc = await Booking.create({ store: s._id, customer: req.user._id, product: p._id, serviceName: p.name, packageName: chosen?.name || "", type, date, time,
    duration: chosen?.duration || p.duration || 0, price, addons: picked, info: { name, phone, address: String(b.address || "").trim().slice(0, 300), note: String(b.note || "").trim().slice(0, 500) },
    history: [{ status: "pending", note: type === "request" ? "Request sent" : "Booking placed" }] });
  U.bg(U.notify(s.owner, type === "request" ? "New service request" : "New booking", `${p.name}${date ? " - " + date + (time ? " " + time : "") : ""} from ${name}`, "/seller/bookings"));
  U.bg(U.log(req, "booking.placed", { service: p.name, type }, { store: s._id }));
  res.status(201).json({ booking: doc });
}));

r.get("/bookings", ...customer, wrap(async (req, res) =>
  res.json({ items: await Booking.find({ customer: req.user._id, store: req.store._id }).sort({ createdAt: -1 }).limit(100).lean() })));

r.post("/bookings/:id/cancel", ...customer, wrap(async (req, res) => {
  const b = await Booking.findOne({ _id: req.params.id, customer: req.user._id, store: req.store._id });
  if (!b) throw U.fail(404, "Booking not found.");
  if (!["pending", "confirmed"].includes(b.status)) throw U.fail(400, "This booking can no longer be cancelled.");
  b.status = "cancelled"; b.history.push({ status: "cancelled", note: "Cancelled by customer" }); await b.save();
  U.bg(U.notify(req.store.owner, "Booking cancelled", `${b.serviceName} ${b.date || ""} ${b.time || ""} was cancelled by the customer.`, "/seller/bookings"));
  res.json({ booking: b });
}));

module.exports = r;
