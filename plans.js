// Subscription plans live in MongoDB (collection "plans") so the owner can edit price and limits from the admin panel.
// The three defaults below are only used to fill an empty database the first time the server starts.
const { Plan, Product } = require("./models");

const DEFAULTS = [
  { name: "Basic", price: 499, maxProducts: 25, maxImages: 3, sort: 1 },
  { name: "Pro", price: 799, maxProducts: 35, maxImages: 5, sort: 2 },
  { name: "Premium", price: 999, maxProducts: 50, maxImages: 8, sort: 3 }
];
let memo = { at: 0, list: [] };
const bust = () => { memo.at = 0; };

async function seed() {
  for (const d of DEFAULTS) await Plan.updateOne({ name: d.name }, { $setOnInsert: d }, { upsert: true });
  bust();
}
async function all() {
  if (Date.now() - memo.at < 30000 && memo.list.length) return memo.list;
  memo = { at: Date.now(), list: await Plan.find().sort({ sort: 1, price: 1 }).lean() };
  return memo.list;
}
// Case-insensitive lookup; an unknown / legacy plan name falls back to the cheapest plan so a store is never left without limits.
async function planFor(name) {
  const list = await all();
  const key = String(name || "").trim().toLowerCase();
  return list.find((p) => p.name.toLowerCase() === key) || list[0] || DEFAULTS[0];
}

// Product + image usage of one store against its plan. Images = gallery photos + colour photos.
async function usageOf(store) {
  const plan = await planFor(store.subscription?.plan);
  const [row] = await Product.aggregate([
    { $match: { store: store._id } },
    { $group: { _id: null, products: { $sum: 1 },
      images: { $sum: { $add: [{ $size: { $ifNull: ["$images", []] } }, { $size: { $filter: { input: { $ifNull: ["$colors", []] }, as: "c", cond: { $gt: [{ $strLenCP: { $ifNull: ["$$c.image", ""] } }, 0] } } } }] } } } }
  ]);
  const products = row?.products || 0, images = row?.images || 0, imageCap = plan.maxProducts * plan.maxImages;
  return { plan: { name: plan.name, price: plan.price, maxProducts: plan.maxProducts, maxImages: plan.maxImages },
    products, images, productCap: plan.maxProducts, imageCap,
    productsLeft: Math.max(0, plan.maxProducts - products), imagesLeft: Math.max(0, imageCap - images) };
}
module.exports = { seed, all, planFor, usageOf, bust, DEFAULTS };
