// Subscription renewal rules. Everything the seller's Subscription page and the admin's Renewals page rely on lives here,
// so the price and the new end date are always calculated on the SERVER (the browser only displays them).
const { Setting, Product } = require("./models");
const Plans = require("./plans");
const U = require("./utils");

// months bought -> days added. 12 months = 365 days.
const MONTHS = { 1: 30, 3: 90, 6: 180, 12: 365 };
const METHODS = ["bank", "jazzcash", "easypaisa"];

const blank = () => ({ enabled: false, bankName: "", title: "", number: "", iban: "" });
const clean = (x = {}) => ({ enabled: !!x.enabled, bankName: String(x.bankName || "").trim().slice(0, 80), title: String(x.title || "").trim().slice(0, 80),
  number: String(x.number || "").trim().slice(0, 60), iban: String(x.iban || "").trim().slice(0, 60) });
const pct = (v) => Math.min(90, Math.max(0, Math.round(Number(v) || 0)));

// Where sellers send their subscription money (owner edits this in Admin > Renewals > Payment details).
async function getPay() {
  const v = (await Setting.findById("platformPay").lean())?.value || {};
  const out = { discounts: { 3: pct(v.discounts?.[3]), 6: pct(v.discounts?.[6]), 12: pct(v.discounts?.[12]) }, instructions: String(v.instructions || "").slice(0, 500) };
  for (const m of METHODS) out[m] = { ...blank(), ...clean(v[m]) };
  return out;
}
function cleanPay(b = {}) {
  const out = { discounts: { 3: pct(b.discounts?.[3]), 6: pct(b.discounts?.[6]), 12: pct(b.discounts?.[12]) }, instructions: String(b.instructions || "").trim().slice(0, 500) };
  for (const m of METHODS) {
    out[m] = clean(b[m]);
    if (out[m].enabled && !out[m].number) throw U.fail(400, `Enter the account / mobile number for ${m}, or turn it off.`);
  }
  return out;
}
// Only what a seller needs to pay: enabled methods + instructions + the multi-month discounts.
const publicPay = (pay) => ({
  methods: Object.fromEntries(METHODS.filter((m) => pay[m].enabled).map((m) => [m, { bankName: pay[m].bankName, title: pay[m].title, number: pay[m].number, iban: pay[m].iban }])),
  discounts: pay.discounts, instructions: pay.instructions
});

// Price for `months` of `planName`. Throws a readable error for anything the seller should not be able to buy.
async function quote(planName, months, pay) {
  months = Number(months);
  if (!Object.prototype.hasOwnProperty.call(MONTHS, months)) throw U.fail(400, "Choose 1, 3, 6 or 12 months.");
  const plan = (await Plans.all()).find((p) => p.name.toLowerCase() === String(planName || "").toLowerCase() && p.active);
  if (!plan) throw U.fail(400, "Choose one of the available plans.");
  const discount = months === 1 ? 0 : pay.discounts[months] || 0;
  const amount = Math.round(plan.price * months * (1 - discount / 100));
  if (amount <= 0) throw U.fail(400, "This plan has no price set. Please chat with Orderistan admin to activate it.");
  return { plan, months, days: MONTHS[months], discount, amount };
}

// What the store currently holds: number of items and the most photos on any one item.
async function footprint(store) {
  const [row] = await Product.aggregate([
    { $match: { store: store._id } },
    { $project: { n: { $add: [{ $size: { $ifNull: ["$images", []] } }, { $size: { $filter: { input: { $ifNull: ["$colors", []] }, as: "c", cond: { $gt: [{ $strLenCP: { $ifNull: ["$$c.image", ""] } }, 0] } } } }] } } },
    { $group: { _id: null, products: { $sum: 1 }, maxImg: { $max: "$n" } } }
  ]);
  return { products: row?.products || 0, maxItemImages: row?.maxImg || 0 };
}
// A cheaper plan is only allowed when the seller's existing items still fit inside it (nothing is ever deleted automatically).
async function fitError(store, plan) {
  const fp = await footprint(store), what = store.category === "services" ? "services" : "products";
  if (fp.products > plan.maxProducts) return `You have ${fp.products} ${what} but the ${plan.name} plan allows ${plan.maxProducts}. Remove some first or choose a bigger plan.`;
  if (fp.maxItemImages > plan.maxImages) return `One of your items has ${fp.maxItemImages} photos but the ${plan.name} plan allows ${plan.maxImages} per item. Remove photos first or choose a bigger plan.`;
  return "";
}

// activate = store is not live yet (new / expired / deactivated); otherwise renew (same plan) or upgrade / downgrade.
async function kindOf(store, plan) {
  if (!store.isLive()) return "activate";
  const cur = await Plans.planFor(store.subscription?.plan);
  if (cur.name === plan.name) return "renew";
  return plan.price > cur.price ? "upgrade" : "downgrade";
}

// Applies an approved request to the store. A live store keeps its remaining days (the bought days are added after the current end date);
// an expired / new store starts today. The plan switches immediately.
async function apply(store, rq, now = new Date()) {
  const plan = (await Plans.all()).find((p) => p.name.toLowerCase() === String(rq.plan).toLowerCase());
  if (!plan) throw U.fail(400, `The ${rq.plan} plan no longer exists. Reject this request and ask the seller to choose another plan.`);
  const err = await fitError(store, plan); if (err) throw U.fail(400, "Cannot approve: " + err);
  const wasLive = store.isLive();
  const end = new Date(+(wasLive ? store.subscription.endsAt : now) + rq.days * U.DAY);
  if (!wasLive) store.subscription.startsAt = now;
  Object.assign(store.subscription, { endsAt: end, plan: plan.name, notified: [] });
  store.status = "active";
  await store.save(); await U.syncLive(store);
  return { endsAt: end, wasLive };
}

module.exports = { MONTHS, METHODS, getPay, cleanPay, publicPay, quote, footprint, fitError, kindOf, apply };
