// Customer account area on orderistan.site: orders and wishlist across ALL stores.
const r = require("express").Router();
const { Order, Wishlist, User } = require("../models");
const otp = require("../otp");
const mailer = require("../mailer");
const P = require("../password");
const { protect, allowRoles, wrap } = require("../guards");
const U = require("../utils");

r.use(protect, allowRoles("customer"));

r.get("/orders", wrap(async (req, res) => {
  const f = { customer: req.user._id };
  if (req.query.status) f.status = U.qs(req.query.status, 30);
  res.json(U.ordersView(await U.paged(Order, f, { page: req.query.page, limit: 10, populate: [{ path: "store", select: "name slug whatsapp phone logo themeColor" }] })));
}));

r.get("/wishlist", wrap(async (req, res) => {
  const rows = await Wishlist.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(200)
    .populate("product").populate("store", "name slug status subscription").lean();
  const now = new Date();
  const items = rows.filter((x) => x.product && x.product.active && x.store && x.store.status === "active" && x.store.subscription?.endsAt > now)
    .map((x) => ({ ...x.product, storeInfo: { slug: x.store.slug, name: x.store.name } }));
  res.json({ items });
}));

r.get("/summary", wrap(async (req, res) => {
  const [orders, open, wishlist] = await Promise.all([
    Order.countDocuments({ customer: req.user._id }),
    Order.countDocuments({ customer: req.user._id, status: { $nin: ["delivered", "cancelled"] } }),
    Wishlist.countDocuments({ user: req.user._id })
  ]);
  res.json({ orders, open, wishlist });
}));

// ---- Link a Gmail address to this customer account --------------------------------------------------------------------------
// 1. POST /me/gmail {email}: a 6-digit code is sent TO that Gmail (proves the person owns it). Replacing an already linked Gmail also needs the current password.
// 2. POST /me/gmail/verify {email, code}: the right code links it. The code is bound to this user and to purpose "link".
// Only Gmail addresses are accepted. Routes are customer-only (protect + allowRoles above); sellers and the owner have no such route.
const GMAIL = /^[a-z0-9][a-z0-9._+-]{0,63}@(gmail|googlemail)\.com$/;
const gmailOf = (v) => {
  const e = String(v || "").trim().toLowerCase().slice(0, 100);
  if (!GMAIL.test(e)) throw U.fail(400, "Enter a valid Gmail address, for example name@gmail.com.");
  return e.replace(/@googlemail\.com$/, "@gmail.com");
};

r.post("/gmail", wrap(async (req, res) => {
  const email = gmailOf(req.body.email);
  const me = await User.findById(req.user._id).select("+password name email");
  if (me.email) {
    if (!req.body.password) throw U.fail(400, "Enter your current password to change your linked Gmail.");
    if (!(await P.compare(String(req.body.password).slice(0, 200), me.password))) throw U.fail(400, "Current password is incorrect.");
  }
  if (me.email === email) throw U.fail(400, "This Gmail is already linked to your account.");
  const key = U.gmailKey(email);
  if (await User.exists({ $or: [{ email }, { emailKey: key }], _id: { $ne: me._id } }) || await User.exists({ emailKey: key, _id: { $ne: me._id } }))
    throw U.fail(409, "This Gmail is already linked to another account.");
  await otp.deliver(email, "link", await otp.issue(email, "link", { userId: String(me._id) }), me.name);
  res.json({ message: `We sent a 6-digit code to ${email}.`, email, expiresInMinutes: otp.TTL_MIN });
}));

r.post("/gmail/verify", wrap(async (req, res) => {
  const email = gmailOf(req.body.email);
  const payload = await otp.verify(email, "link", req.body.code);   // single use, 5 wrong tries burn it
  if (!payload || payload.userId !== String(req.user._id)) throw U.fail(400, "That code is invalid or has expired. Request a new one.");
  const key = U.gmailKey(email);
  if (await User.exists({ $or: [{ email }, { emailKey: key }], _id: { $ne: req.user._id } })) throw U.fail(409, "This Gmail is already linked to another account.");
  const before = await User.findById(req.user._id).select("email name").lean();
  let user;
  try { user = await User.findByIdAndUpdate(req.user._id, { email, emailKey: key, emailVerified: true }, { new: true }); }
  catch (e) { if (e.code === 11000) throw U.fail(409, "This Gmail is already linked to another account."); throw e; }
  U.bg(U.log(req, "customer.gmail_linked", { email }, { actor: user }));
  // Security notice to the Gmail that was replaced, so a takeover is noticed by the real owner
  if (before?.email && before.email !== email) U.bg(mailer.sendGmailChanged({ to: before.email, name: before.name, newEmail: email }));
  res.json({ user: U.safeUser(user) });
}));

module.exports = r;
