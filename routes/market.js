// Public marketplace on orderistan.site: browse every live seller store and search products across stores.
// Only public fields are exposed (never owner email, payment details or subscription data).
const r = require("express").Router();
const { Store, Product, keywordFilter } = require("../models");
const { wrap } = require("../guards");
const U = require("../utils");
const { TTLCache } = require("../cache");
const citiesCache = new TTLCache(60 * 1000, 1);   // city list changes rarely; saves a DISTINCT query on every marketplace page load

const liveFilter = () => ({ status: "active", "subscription.endsAt": { $gt: new Date() } });
const card = (s, count = 0) => ({
  slug: s.slug, name: s.name, tagline: s.tagline, logo: s.logo, banner: s.banner,
  city: s.city, themeColor: s.themeColor, category: s.category || "", products: count
});

r.get("/stores", wrap(async (req, res) => {
  const f = liveFilter();
  if (req.query.q) { const rx = new RegExp(U.esc(U.qs(req.query.q)), "i"); f.$or = [{ name: rx }, { tagline: rx }, { slug: rx }]; }
  if (["food", "clothing", "services"].includes(U.qs(req.query.category, 20))) f.category = U.qs(req.query.category, 20);
  if (req.query.city) f.city = new RegExp("^" + U.esc(U.qs(req.query.city)) + "$", "i");
  const data = await U.paged(Store, f, { page: req.query.page, limit: req.query.limit || 12, select: "slug name tagline logo banner city themeColor category" });
  const counts = await Product.aggregate([
    { $match: { store: { $in: data.items.map((s) => s._id) }, active: true } },
    { $group: { _id: "$store", n: { $sum: 1 } } }
  ]);
  const cm = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  data.items = data.items.map((s) => card(s, cm[String(s._id)] || 0));
  res.json(data);
}));

r.get("/cities", wrap(async (_req, res) => {
  let items = citiesCache.get("c");
  if (!items) { items = (await Store.distinct("city", liveFilter())).filter(Boolean).sort(); citiesCache.set("c", items); }
  res.set("Cache-Control", "public, max-age=60");
  res.json({ items });
}));

// Uses the denormalised Product.live flag (kept in sync by U.syncLive / jobs.js), so there is no "load every live store, then $in" step
// and every filter/sort below is served by an index.
r.get("/products", wrap(async (req, res) => {
  const f = { live: true, active: true, inStock: true };
  const kw = req.query.q && keywordFilter(U.qs(req.query.q)); if (kw) f.keywords = kw;
  if (req.query.category) f.category = U.qs(req.query.category, 40);
  const sort = U.sortBy({ newest: { createdAt: -1 }, price_asc: { price: 1 }, price_desc: { price: -1 }, popular: { sold: -1 } }, req.query.sort, { createdAt: -1 });
  const data = await U.paged(Product, f, { sort, page: req.query.page, limit: req.query.limit || 24 });
  const stores = await Store.find({ _id: { $in: [...new Set(data.items.map((p) => String(p.store)))] } }).select("slug name").lean();
  const byId = new Map(stores.map((s) => [String(s._id), s]));
  data.items = data.items.map(({ live, ...p }) => ({ ...p, storeInfo: { slug: byId.get(String(p.store))?.slug, name: byId.get(String(p.store))?.name } }));
  res.json(data);
}));

module.exports = r;
