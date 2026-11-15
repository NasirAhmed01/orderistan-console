const jwt = require("jsonwebtoken");
const P = require("./password");
const { User, Store, Product, Notification, Log } = require("./models");

const DAY = 864e5;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RESERVED = new Set(["www", "admin", "api", "app", "mail", "s", "seller", "sellers", "login", "register", "static", "uploads",
  "support", "help", "blog", "shop", "store", "ftp", "cdn", "dashboard", "orderistan", "ns1", "ns2", "smtp", "root", "test"]);
const validSlug = (s) => /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(s) && !RESERVED.has(s);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Safe lookup in a table of allowed sort orders (a plain `table[req.query.sort]` would accept "constructor" / "__proto__").
const sortBy = (table, key, dflt) => (typeof key === "string" && hasOwn(table, key) ? table[key] : dflt);
// Query-string values can arrive as arrays/objects (?status[]=a). Always turn them into one short string.
const qs = (v, max = 60) => (v === undefined || v === null ? "" : String(Array.isArray(v) ? v[0] : v).slice(0, max));
const money = (v, max = 1e8) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0; };
// Runs slow, non-essential work (notifications, activity log) AFTER the response, so the customer does not wait for it.
// On Vercel the function is frozen as soon as the response is sent, so background work must be registered with waitUntil.
let waitUntil = null; try { ({ waitUntil } = require("@vercel/functions")); } catch { /* local dev: plain background promise */ }
const bg = (p) => {
  const pr = Promise.resolve(p).catch((e) => console.error("background task failed:", e?.message || e));
  if (waitUntil) { try { waitUntil(pr); } catch { /* not inside a Vercel request */ } }
};
const fail = (status, message) => Object.assign(new Error(message), { status });

const token = (u) => jwt.sign({ sub: u._id, role: u.role, tv: u.tokenVersion || 0 }, process.env.JWT_SECRET, {
  algorithm: "HS256",
  expiresIn: u.role === "admin" ? (process.env.ADMIN_JWT_EXPIRES_IN || "2h") : (process.env.JWT_EXPIRES_IN || "7d")
});

// Normal accounts: 8-72 chars (bcrypt ignores everything after 72 bytes), at least one letter and one number, and not a well-known
// password. These are the first passwords bulk-guessing tools try. Existing accounts are not affected (only NEW passwords are checked).
const COMMON_PW = new Set(["12345678", "123456789", "1234567890", "11111111", "00000000", "87654321", "password", "password1", "password123", "qwerty123",
  "qwertyuiop", "iloveyou", "11223344", "abc12345", "abcd1234", "admin123", "welcome1", "welcome123", "letmein123", "pakistan", "pakistan123", "orderistan",
  "orderistan123", "123123123", "112233445", "03001234567", "1q2w3e4r", "1qaz2wsx", "zxcvbnm123", "asdfghjk", "asdf1234", "football1", "monkey123", "dragon123"]);
const checkPassword = (pw, label = "Password", email = "") => {
  pw = String(pw || "");
  if (pw.length < 8) throw fail(400, `${label} must be at least 8 characters.`);
  if (pw.length > 72) throw fail(400, `${label} must be at most 72 characters.`);
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw fail(400, `${label} must contain at least one letter and one number.`);
  const low = pw.toLowerCase();
  if (COMMON_PW.has(low) || /^(.)\1+$/.test(pw) || (email && low === String(email).toLowerCase())) throw fail(400, `${label} is too easy to guess. Choose something less common.`);
  return pw;
};
// Owner/admin account: 12+ chars, 3 of 4 character types, no default/common words.
const WEAK_PW = /change.?this|password|passw0rd|admin|orderistan|qwerty|letmein|welcome|12345|abcdef/i;
const isWeakPassword = (pw) => {
  pw = String(pw || "");
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return pw.length < 12 || pw.length > 72 || kinds < 3 || WEAK_PW.test(pw) || /(.)\1{3,}/.test(pw);
};
const WEAK_ADMIN_MSG = "Owner password must be 12-72 characters with upper case, lower case, numbers and symbols, and must not contain common words like 'password' or 'admin'.";
// Customer usernames: 3-20 chars, start with a letter, letters/digits/_/. only, not reserved.
const USERNAME_RE = /^[a-z][a-z0-9_.]{2,19}$/;
const RESERVED_USERNAMES = new Set(["admin", "administrator", "owner", "root", "support", "help", "orderistan", "seller", "sellers", "store", "stores", "api", "login", "register", "account", "null", "undefined"]);
const validUsername = (s) => USERNAME_RE.test(s) && !RESERVED_USERNAMES.has(s) && !/[._]$/.test(s) && !/\.\./.test(s);
// Gmail ignores dots and "+tag" in the local part, so these are one inbox. Used to stop one inbox being linked to two accounts.
const gmailKey = (email) => String(email || "").toLowerCase().split("@")[0].split("+")[0].replace(/\./g, "") + "@gmail.com";
const safeUser = (u) => ({ id: u._id, name: u.name, email: u.email || "", username: u.username || "", role: u.role, phone: u.phone || "", avatar: u.avatar || "", status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null });

async function log(req, action, meta = {}, o = {}) {
  try {
    const a = o.actor || req.user;
    if (meta && typeof meta.email === "string") meta = { ...meta, email: meta.email.slice(0, 100) };
    await Log.create({ actor: a?._id, actorName: String(a?.name || meta.email || "system").slice(0, 100), role: a?.role || "", action, store: o.store, meta, ip: req.ip });
  } catch (e) { console.error("log failed:", e.message); }
}
async function notify(users, title, body = "", link = "") {
  const ids = [].concat(users).filter(Boolean);
  if (ids.length) await Notification.insertMany(ids.map((user) => ({ user, title, body, link })), { ordered: false }).catch((e) => console.error("notify failed:", e.message));
}
async function notifyAdmins(title, body, link) {
  const a = await User.find({ role: "admin" }).select("_id").lean();
  return notify(a.map((x) => x._id), title, body, link);
}
// Orders sent to a browser never contain the private Cloudinary id of the payment screenshot. The browser only learns THAT a
// screenshot exists (hasScreenshot) and fetches the picture through GET /orders/:id/screenshot, which checks who is asking.
const orderView = (o) => {
  if (!o) return o;
  const x = typeof o.toObject === "function" ? o.toObject() : { ...o };
  const { paymentScreenshot, ...rest } = x;
  return { ...rest, hasScreenshot: !!paymentScreenshot };
};
const ordersView = (page) => ({ ...page, items: page.items.map(orderView) });

async function paged(Model, filter, { sort = { createdAt: -1 }, page = 1, limit = 20, populate = [], select } = {}) {
  page = Math.min(1000, Math.max(1, parseInt(page) || 1)); limit = Math.min(100, Math.max(1, parseInt(limit) || 20)); // deep pages are capped (skip() cost grows with the page number)
  let q = Model.find(filter).sort(sort).skip((page - 1) * limit).limit(limit);
  if (select) q = q.select(select);
  for (const p of populate) q = q.populate(p);
  const [items, total] = await Promise.all([q.lean(), Model.countDocuments(filter)]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

async function createSeller({ name, email, password, passwordHash, phone = "", storeName, slug, days = 0, plan = "Basic", category = "", emailVerified = false, terms }) {
  name = String(name || "").trim().slice(0, 80); email = String(email || "").trim().toLowerCase();
  password = String(password || ""); storeName = String(storeName || "").trim(); slug = String(slug || "").trim().toLowerCase();
  if (name.length < 2) throw fail(400, "Name must be at least 2 characters.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, "Enter a valid email address.");
  if (!passwordHash) checkPassword(password, "Password", email);   // passwordHash = already validated + hashed at the OTP step
  if (storeName.length < 2) throw fail(400, "Enter your store name.");
  if (!validSlug(slug)) throw fail(400, "Store link must be 3-30 letters, numbers or hyphens (and not a reserved word).");
  category = String(category || "").trim().toLowerCase();
  if (category && !["food", "clothing", "services"].includes(category)) throw fail(400, "Choose a valid business category.");
  if (await User.exists({ email })) throw fail(409, "An account with this email already exists.");
  if (await Store.exists({ slug })) throw fail(409, "This store link is already taken.");
  const user = await User.create({ name, email, phone: String(phone).trim().slice(0, 30), password: passwordHash || await P.hash(password), role: "seller", emailVerified, ...(terms ? { terms } : {}) });
  try {
    const data = { owner: user._id, slug, category, name: storeName.slice(0, 80), phone: user.phone, whatsapp: user.phone, subscription: { plan } };
    days = Math.min(3650, parseInt(days) || 0);
    if (days > 0) Object.assign(data, { status: "active", subscription: { plan, startsAt: new Date(), endsAt: new Date(Date.now() + days * DAY), notified: [] } });
    const store = await Store.create(data);
    return { user, store };
  } catch (e) { await User.deleteOne({ _id: user._id }); throw e; }
}

// Keeps Product.live (used by the marketplace) equal to "this store is live". Call after any change of a store's status/subscription.
async function syncLive(storeOrId) {
  const s = storeOrId?.isLive ? storeOrId : await Store.findById(storeOrId);
  if (!s) return;
  const live = s.isLive();
  await Product.updateMany({ store: s._id, live: { $ne: live } }, { live });
}

module.exports = { DAY, hasOwn, sortBy, qs, money, bg, syncLive, esc, validSlug, fail, token, checkPassword, isWeakPassword, WEAK_ADMIN_MSG, safeUser, log, notify, notifyAdmins, paged, createSeller, orderView, ordersView, validUsername, gmailKey };
