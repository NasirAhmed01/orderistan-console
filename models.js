const mongoose = require("mongoose");
const cache = require("./cache");
const { Schema, model } = mongoose;
const ref = (r, o = {}) => ({ type: Schema.Types.ObjectId, ref: r, ...o });
const str = (d = "", o = {}) => ({ type: String, default: d, trim: true, ...o });
const T = { timestamps: true };

// Any write to a User/Store clears the matching entry from the in-process auth/tenant caches (see cache.js).
// byId = true: drop just that user; false (stores): drop the whole small cache, store writes are rare.
function invalidates(schema, bucket, byId) {
  const drop = (id) => (byId && id ? bucket.del(String(id)) : bucket.clear());
  schema.post("save", function (doc) { drop(doc._id); });
  schema.post("deleteOne", { document: true, query: false }, function () { drop(this._id); });
  schema.post(["updateOne", "updateMany", "findOneAndUpdate", "findOneAndDelete", "deleteOne", "deleteMany"], { query: true, document: false }, function () {
    const id = this.getFilter?.()._id;
    drop(id && (typeof id === "string" || id._bsontype === "ObjectId") ? id : null);
  });
}

const userSchema = new Schema({
  name: str("", { required: true, maxlength: 80 }),
  // email is optional: a customer can sign up with a username only and link a Gmail later (uniqueness: partial indexes below)
  email: { type: String, lowercase: true, trim: true },
  username: { type: String, lowercase: true, trim: true, maxlength: 20 },   // customers only; unique when set
  emailKey: { type: String },   // canonical Gmail (dots and +tags removed), unique when set: one inbox, one account
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ["admin", "seller", "customer"], default: "customer" },
  phone: str("", { maxlength: 30 }),
  avatar: { type: String, default: "" },        // profile picture URL (Cloudinary, orderistan/avatars)
  status: { type: String, enum: ["active", "suspended"], default: "active" },
  lastLoginAt: Date,
  tokenVersion: { type: Number, default: 0 },   // bump to instantly revoke every token of this user
  failedLogins: { type: Number, default: 0 },
  lastFailedAt: Date,                           // failures only count inside a time window (see routes/auth.js)
  lockUntil: Date,
  lockLevel: { type: Number, default: 0 },      // escalating lock-outs: each new lock within 24 h lasts longer (see routes/auth.js)
  lastLockAt: Date,
  emailVerified: { type: Boolean, default: false },  // true once the signup OTP was entered (older accounts stay false and still work)
  terms: { type: new Schema({ version: String, at: Date, ip: String }, { _id: false }), default: undefined }   // proof of acceptance of Terms / Privacy (older accounts have none)
}, T);
userSchema.index({ role: 1, createdAt: -1 });
// Unique only when the field is set, so many username-only customers can exist side by side.
userSchema.index({ email: 1 }, { unique: true, name: "email_unique_partial", partialFilterExpression: { email: { $type: "string" } } });
userSchema.index({ emailKey: 1 }, { unique: true, name: "emailKey_unique", partialFilterExpression: { emailKey: { $type: "string" } } });
userSchema.index({ username: 1 }, { unique: true, name: "username_unique", partialFilterExpression: { username: { $type: "string" } } });
invalidates(userSchema, cache.users, true);
const User = model("User", userSchema);

const payMethod = new Schema({
  enabled: { type: Boolean, default: false },
  bankName: str("", { maxlength: 80 }), title: str("", { maxlength: 80 }),
  number: str("", { maxlength: 60 }), iban: str("", { maxlength: 60 }),
  fee: { type: Number, default: 0, min: 0, max: 100000 }   // extra Rs charged when the customer picks this method; only the "cod" method uses it
}, { _id: false });
const pm = { type: payMethod, default: () => ({}) };

const storeSchema = new Schema({
  owner: ref("User", { required: true, unique: true }),
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: str("", { required: true, maxlength: 80 }),
  tagline: str("", { maxlength: 160 }), description: str("", { maxlength: 2000 }),
  logo: str(), banner: str(), phone: str("", { maxlength: 30 }), whatsapp: str("", { maxlength: 30 }),
  address: str("", { maxlength: 300 }), city: str("", { maxlength: 60 }),
  themeColor: str("#e4572e"),
  deliveryFee: { type: Number, default: 0, min: 0 }, freeDeliveryOver: { type: Number, default: 0, min: 0 },
  payment: { bank: pm, jazzcash: pm, easypaisa: pm, cod: pm },
  category: { type: String, enum: ["", "food", "clothing", "services"], default: "" },   // "" = store created before industries existed (classic layout)
  availability: {                                    // services: weekly opening hours used to build booking slots
    days: { type: [new Schema({ day: Number, open: Boolean, from: String, to: String }, { _id: false })], default: [] },
    slotMinutes: { type: Number, default: 60, min: 15, max: 480 },
    capacity: { type: Number, default: 1, min: 1, max: 50 },   // how many bookings can share one slot
    leadHours: { type: Number, default: 2, min: 0, max: 720 }
  },
  status: { type: String, enum: ["pending", "active", "inactive", "expired"], default: "pending" },
  subscription: { plan: str("Basic"), startsAt: Date, endsAt: Date, notified: [Number] }
}, T);
storeSchema.index({ status: 1, "subscription.endsAt": 1 });   // marketplace + expiry job
storeSchema.index({ city: 1 });
storeSchema.methods.isLive = function () {
  return this.status === "active" && !!this.subscription?.endsAt && this.subscription.endsAt > new Date();
};
invalidates(storeSchema, cache.stores, false);
const Store = model("Store", storeSchema);

// Search keywords: every word of the name plus all of its prefixes ("biryani" -> b, bi, bir ...). A multikey index on this field makes
// product search use an index (a `/regex/i` search cannot) while still matching as you type.
const KW_MAX_WORDS = 12, KW_MAX_LEN = 15;
const words = (s) => String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const keywordsOf = (name) => {
  const set = new Set();
  for (const w of words(name).slice(0, KW_MAX_WORDS)) for (let i = 1; i <= Math.min(w.length, KW_MAX_LEN); i++) set.add(w.slice(0, i));
  return [...set];
};
// Turns a search text into a Mongo condition on `keywords`, or null if the text has no searchable words.
const keywordFilter = (q) => {
  const w = [...new Set(words(String(q).slice(0, 60)).map((x) => x.slice(0, KW_MAX_LEN)))].slice(0, 5);
  return w.length === 0 ? null : w.length === 1 ? w[0] : { $all: w };
};

const productSchema = new Schema({
  store: ref("Store", { required: true }),
  live: { type: Boolean, default: false },       // copy of "this product's store is live"; kept in sync by U.syncLive()
  name: str("", { required: true, maxlength: 120 }), description: str("", { maxlength: 3000 }),
  price: { type: Number, required: true, min: 0 }, comparePrice: { type: Number, default: 0, min: 0 },
  category: str("General", { maxlength: 40 }), images: [String],
  keywords: { type: [String], select: false },
  inStock: { type: Boolean, default: true }, active: { type: Boolean, default: true },
  stock: { type: Number, default: null, min: 0 },   // null = stock is not tracked
  sku: str("", { maxlength: 40 }),
  // FOOD
  sizes: { type: [new Schema({ name: String, price: Number, enabled: { type: Boolean, default: true } }, { _id: false })], default: [] },
  addons: { type: [new Schema({ name: String, price: Number, group: String, enabled: { type: Boolean, default: true } }, { _id: false })], default: [] },
  deal: { type: new Schema({ kind: { type: String, enum: ["", "percent", "bogo", "combo"], default: "" }, value: { type: Number, default: 0 }, label: String, items: [String] }, { _id: false }), default: () => ({}) },
  // CLOTHING
  sizeChart: { type: new Schema({ unit: { type: String, enum: ["in", "cm"], default: "in" }, columns: [String],
    rows: [new Schema({ size: String, enabled: { type: Boolean, default: true }, values: [String] }, { _id: false })] }, { _id: false }), default: () => ({}) },
  colors: { type: [new Schema({ name: String, hex: String, image: { type: String, default: "" }, enabled: { type: Boolean, default: true } }, { _id: false })], default: [] },
  variants: { type: [new Schema({ size: { type: String, default: "" }, color: { type: String, default: "" }, sku: String, stock: { type: Number, default: null }, price: { type: Number, default: 0 }, enabled: { type: Boolean, default: true } }, { _id: false })], default: [] },
  // SERVICES
  duration: { type: Number, default: 0, min: 0 },
  bookingMode: { type: String, enum: ["booking", "request"], default: "booking" },
  packages: { type: [new Schema({ name: String, price: Number, duration: Number, description: String, enabled: { type: Boolean, default: true } }, { _id: false })], default: [] },
  ratingAvg: { type: Number, default: 0 }, ratingCount: { type: Number, default: 0 }, sold: { type: Number, default: 0 }
}, T);
productSchema.pre("save", function (next) { if (this.isNew || this.isModified("name")) this.keywords = keywordsOf(this.name); next(); });
// per-store pages (storefront + seller dashboard)
productSchema.index({ store: 1, active: 1, createdAt: -1 });
productSchema.index({ store: 1, active: 1, category: 1 });
productSchema.index({ store: 1, createdAt: -1 });
// marketplace (all live stores)
productSchema.index({ live: 1, active: 1, inStock: 1, createdAt: -1 });
productSchema.index({ live: 1, active: 1, inStock: 1, price: 1 });
productSchema.index({ live: 1, active: 1, inStock: 1, sold: -1 });
productSchema.index({ live: 1, active: 1, inStock: 1, category: 1, createdAt: -1 });
productSchema.index({ keywords: 1, live: 1 });
const Product = model("Product", productSchema);

const orderSchema = new Schema({
  orderNo: { type: String, unique: true },
  store: ref("Store", { required: true }), customer: ref("User", { required: true }),
  items: [new Schema({ product: ref("Product"), name: String, price: Number, qty: Number, image: String, lineTotal: Number, size: String, color: String, sku: String, addons: [String], deal: String }, { _id: false })],
  subtotal: Number, deliveryFee: Number, codFee: { type: Number, default: 0 }, total: Number,
  info: { name: String, phone: String, address: String, note: String },
  paymentMethod: { type: String, enum: ["bank", "jazzcash", "easypaisa", "cod"] },
  paymentScreenshot: { type: String, default: "" },
  paymentStatus: { type: String, enum: ["unpaid", "submitted", "verified", "rejected", "cod"], default: "unpaid" },
  paymentNote: { type: String, default: "" },
  status: { type: String, enum: ["pending", "confirmed", "preparing", "out_for_delivery", "delivered", "cancelled"], default: "pending" },
  history: [new Schema({ status: String, note: String, at: { type: Date, default: Date.now } }, { _id: false })]
}, { ...T, optimisticConcurrency: true }); // two people changing the same order at once: the second save fails (409) instead of overwriting
orderSchema.index({ store: 1, createdAt: -1 });         // seller order list
orderSchema.index({ customer: 1, createdAt: -1 });      // "my orders"
orderSchema.index({ createdAt: -1 });                   // admin list / stats
orderSchema.index({ store: 1, paymentStatus: 1 });
orderSchema.index({ store: 1, status: 1 });
orderSchema.index({ paymentStatus: 1 });
const Order = model("Order", orderSchema);

const reviewSchema = new Schema({
  store: ref("Store", { required: true }), product: ref("Product", { required: true }), user: ref("User", { required: true }),
  userName: String, rating: { type: Number, min: 1, max: 5, required: true }, comment: str("", { maxlength: 1000 }), verified: Boolean
}, T);
reviewSchema.index({ product: 1, user: 1 }, { unique: true });
reviewSchema.index({ product: 1, createdAt: -1 });
reviewSchema.index({ store: 1 });
const Review = model("Review", reviewSchema);

const wishSchema = new Schema({ user: ref("User", { required: true }), store: ref("Store", { required: true }), product: ref("Product", { required: true }) }, T);
wishSchema.index({ user: 1, product: 1 }, { unique: true });
wishSchema.index({ user: 1, store: 1 });
wishSchema.index({ store: 1 });
const Wishlist = model("Wishlist", wishSchema);

const planSchema = new Schema({
  name: { type: String, required: true, unique: true }, price: { type: Number, default: 0, min: 0 },
  maxProducts: { type: Number, required: true, min: 1 }, maxImages: { type: Number, required: true, min: 1 },   // images allowed PER product
  active: { type: Boolean, default: true }, sort: { type: Number, default: 0 }
}, T);
const Plan = model("Plan", planSchema);

const bookingSchema = new Schema({
  store: ref("Store", { required: true }), customer: ref("User", { required: true }), product: ref("Product", { required: true }),
  serviceName: String, packageName: String, type: { type: String, enum: ["booking", "request"], default: "booking" },
  date: String, time: String,                      // "YYYY-MM-DD" / "HH:MM" in the store's local time
  duration: Number, price: Number, addons: [String],
  info: { name: String, phone: String, address: String, note: String },
  status: { type: String, enum: ["pending", "confirmed", "completed", "cancelled", "rejected"], default: "pending" },
  history: [new Schema({ status: String, note: String, at: { type: Date, default: Date.now } }, { _id: false })]
}, T);
bookingSchema.index({ store: 1, date: 1, time: 1 });
bookingSchema.index({ store: 1, createdAt: -1 });
bookingSchema.index({ customer: 1, store: 1, createdAt: -1 });
const Booking = model("Booking", bookingSchema);

const settingSchema = new Schema({ _id: String, value: Schema.Types.Mixed }, { versionKey: false, _id: false });
const Setting = model("Setting", settingSchema, "settings");

const notifSchema = new Schema({
  user: ref("User", { required: true }), title: String, body: String, link: String, read: { type: Boolean, default: false }
}, T);
notifSchema.index({ user: 1, createdAt: -1 });
notifSchema.index({ user: 1, read: 1 });
notifSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });   // auto-delete after 90 days so the database does not grow forever
const Notification = model("Notification", notifSchema);

const logSchema = new Schema({
  actor: ref("User"), actorName: String, role: String, action: { type: String, index: true },
  store: ref("Store"), meta: Schema.Types.Mixed, ip: String
}, T);
logSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 86400 });    // keep the activity log 180 days
const Log = model("Log", logSchema);

// Proof of cookie consent (POST /api/consent): who chose what, when, under which version. Kept 3 years, then deleted automatically.
const consentSchema = new Schema({
  cid: { type: String, required: true, index: true }, version: String, action: { type: String, enum: ["accept_all", "reject_all", "custom", "update"], default: "custom" },
  choices: { type: new Schema({ necessary: Boolean, preferences: Boolean, analytics: Boolean, marketing: Boolean }, { _id: false }) },
  ip: String, ua: String, host: String
}, T);
consentSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 365 * 86400 });
const ConsentLog = model("ConsentLog", consentSchema);

// Counters for the cluster-safe rate limiter (ratelimit.js). Rows delete themselves when their window ends.
const rlSchema = new Schema({ _id: String, hits: Number, expiresAt: Date }, { versionKey: false, _id: false });
rlSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
model("RateLimit", rlSchema, "ratelimits");

// One-time codes (otp.js): signup verification and password reset. One live row per purpose+email; the row also carries the
// pending signup data (password already hashed) so no account exists until the email is proven. Rows delete themselves (purgeAt).
const otpSchema = new Schema({
  _id: String, codeHash: String, expiresAt: Date, attempts: { type: Number, default: 0 },
  sends: { type: Number, default: 0 }, windowStart: Date, lastSentAt: Date, payload: Schema.Types.Mixed, purgeAt: Date
}, { versionKey: false, _id: false });
otpSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
const Otp = model("Otp", otpSchema, "otps");

// Daily e-mail counters for the admin "System Overview" (sysmonitor.js). ONE tiny row per kind+day (e.g. "otp:2026-11-12"), written by otp.deliver().
// Kept forever on purpose (about 365 rows a year, a few KB) so the "total" figure stays exact; it counts only mails sent since this feature went live.
const mailStatSchema = new Schema({
  _id: String, kind: String, day: String, sent: { type: Number, default: 0 }, failed: { type: Number, default: 0 }, lastSentAt: Date, lastFailedAt: Date
}, { versionKey: false, _id: false });
mailStatSchema.index({ kind: 1, day: 1 });
const MailStat = model("MailStat", mailStatSchema, "mailstats");

// Lock rows so only ONE pm2 worker runs a background job at a time (see jobs.js).
const lockSchema = new Schema({ _id: String, expiresAt: Date }, { versionKey: false, _id: false });
model("Lock", lockSchema, "locks");

// ---- admin <-> seller support chat (one thread per store) + subscription renewal requests -------------------------------------
const chatSchema = new Schema({
  store: ref("Store", { required: true, unique: true }),
  sellerUnread: { type: Number, default: 0 }, adminUnread: { type: Number, default: 0 },   // messages the OTHER side has not opened yet
  sellerSeenAt: Date, adminSeenAt: Date,                                                   // drives the "seen" double tick
  lastMessage: str("", { maxlength: 120 }), lastHasImage: { type: Boolean, default: false }, lastFrom: str(""), lastAt: Date
}, T);
chatSchema.index({ lastAt: -1 });
chatSchema.index({ adminUnread: 1, lastAt: -1 });
const Chat = model("Chat", chatSchema);

const messageSchema = new Schema({
  chat: ref("Chat", { required: true }), store: ref("Store", { required: true }), sender: ref("User", { required: true }),
  from: { type: String, enum: ["seller", "admin"], required: true },
  text: str("", { maxlength: 2000 }),
  image: { type: String, default: "" }          // PRIVATE Cloudinary id (never sent to the browser; images are streamed after a permission check)
}, T);
messageSchema.index({ chat: 1, _id: -1 });
messageSchema.index({ store: 1 });
messageSchema.index({ createdAt: 1 });
const Message = model("Message", messageSchema);

const subReqSchema = new Schema({
  store: ref("Store", { required: true }), owner: ref("User", { required: true }),
  plan: str("", { required: true }), planPrice: Number, months: Number, days: Number, discount: { type: Number, default: 0 }, amount: Number,
  kind: { type: String, enum: ["activate", "renew", "upgrade", "downgrade"], default: "renew" },
  method: { type: String, enum: ["bank", "jazzcash", "easypaisa"], required: true },
  reference: str("", { maxlength: 60 }), note: str("", { maxlength: 300 }),
  proof: { type: String, default: "" },         // PRIVATE Cloudinary id of the payment screenshot
  status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending" },
  adminNote: str("", { maxlength: 300 }), decidedAt: Date, decidedBy: ref("User"), endsAtAfter: Date
}, T);
subReqSchema.index({ store: 1, createdAt: -1 });
subReqSchema.index({ status: 1, createdAt: -1 });
subReqSchema.index({ store: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });   // at most ONE waiting request per store (race-proof)
const SubRequest = model("SubRequest", subReqSchema);

module.exports = { MailStat, Otp, Chat, Message, SubRequest, User, Store, Product, Order, Review, Wishlist, Notification, Log, ConsentLog, Plan, Booking, Setting, keywordsOf, keywordFilter };
