const r = require("express").Router();
const { ConsentLog, Notification, Order, Store, SubRequest } = require("../models");
const { protect, wrap } = require("../guards");
const C = require("../cloud");

// Cookie-consent proof log (public, rate-limited in ratelimit.js). Stores the visitor's choice, never anything else about them.
r.post("/consent", wrap(async (req, res) => {
  const b = req.body || {}, c = b.choices || {}, cid = String(b.cid || "");
  if (!/^[a-f0-9]{16,64}$/.test(cid)) return res.status(400).json({ message: "Invalid request." });
  await ConsentLog.create({
    cid, version: String(b.version || "").slice(0, 12),
    action: ["accept_all", "reject_all", "custom", "update"].includes(b.action) ? b.action : "custom",
    choices: { necessary: true, preferences: c.preferences === true, analytics: c.analytics === true, marketing: c.marketing === true },
    ip: req.ip, ua: String(req.headers["user-agent"] || "").slice(0, 200), host: String(req.headers["x-store-slug"] || req.hostname || "").slice(0, 80)
  });
  res.status(201).json({ ok: true });
}));

r.get("/notifications", protect, wrap(async (req, res) => {
  const [items, unread] = await Promise.all([
    Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(30).lean(),
    Notification.countDocuments({ user: req.user._id, read: false })
  ]);
  res.json({ items, unread });
}));
// Cheap badge poll: one indexed count instead of the whole list (the bell loads the list only when it is opened).
r.get("/notifications/unread", protect, wrap(async (req, res) =>
  res.json({ unread: await Notification.countDocuments({ user: req.user._id, read: false }) })));
r.post("/notifications/read", protect, wrap(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { read: true }); res.json({ ok: true });
}));

// Payment screenshots are private: only the buyer, the store owner and the admin can open them.
r.get("/orders/:id/screenshot", protect, wrap(async (req, res) => {
  const o = await Order.findById(req.params.id).select("customer store paymentScreenshot");
  if (!o || !o.paymentScreenshot) return res.status(404).json({ message: "No screenshot." });
  const ok = req.user.role === "admin" || String(o.customer) === String(req.user._id) ||
    (req.user.role === "seller" && (await Store.exists({ _id: o.store, owner: req.user._id })));
  if (!ok) return res.status(403).json({ message: "Not allowed." });
  await C.streamPrivate(res, o.paymentScreenshot);
}));

// Renewal payment proofs: only the admin and the seller who uploaded it.
r.get("/sub-requests/:id/proof", protect, wrap(async (req, res) => {
  const x = await SubRequest.findById(req.params.id).select("owner proof");
  if (!x || !x.proof) return res.status(404).json({ message: "No screenshot." });
  if (!(req.user.role === "admin" || (req.user.role === "seller" && String(x.owner) === String(req.user._id)))) return res.status(403).json({ message: "Not allowed." });
  await C.streamPrivate(res, x.proof);
}));

module.exports = r;
