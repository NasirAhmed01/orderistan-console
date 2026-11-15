// Seller <-> Orderistan admin support chat (renewals, payment proof, questions). One thread per store.
// Works like a messenger: text + photos, unread counters, "seen" ticks. The browser polls (see frontend/src/chat/Chat.jsx), so it needs
// no extra packages and works behind pm2 cluster / nginx without sticky sessions.
// Photos are PRIVATE Cloudinary files: the browser only gets message ids and fetches the picture through GET /image/:id after a permission check.
const r = require("express").Router();
const mongoose = require("mongoose");
const { Chat, Message, Store, SubRequest } = require("../models");
const { protect, allowRoles, wrap, upload } = require("../guards");
const C = require("../cloud");
const U = require("../utils");

r.use(protect, allowRoles("seller", "admin"));

const FIELD = { seller: { unread: "sellerUnread", seen: "sellerSeenAt" }, admin: { unread: "adminUnread", seen: "adminSeenAt" } };
const peerOf = (role) => (role === "seller" ? "admin" : "seller");
const view = (m) => ({ _id: m._id, from: m.from, text: m.text, hasImage: !!m.image, createdAt: m.createdAt });

// Which store is this request about? A seller always talks about their own store; the admin names the store.
async function threadStore(req) {
  if (req.user.role === "seller") {
    const s = await Store.findOne({ owner: req.user._id }).select("name slug owner status category subscription");
    if (!s) throw U.fail(404, "No store is linked to this account.");
    return s;
  }
  const id = U.qs(req.query.store || req.body?.store, 40);
  if (!mongoose.isValidObjectId(id)) throw U.fail(400, "Choose a seller to chat with.");
  const s = await Store.findById(id).select("name slug owner status category subscription");
  if (!s) throw U.fail(404, "Seller not found.");
  return s;
}

// Navigation badges: seller = unread chat messages; admin = chats with unread messages + renewal requests waiting.
r.get("/badges", wrap(async (req, res) => {
  if (req.user.role === "seller") {
    const s = await Store.findOne({ owner: req.user._id }).select("_id").lean();
    const c = s && (await Chat.findOne({ store: s._id }).select("sellerUnread").lean());
    return res.json({ chat: c?.sellerUnread || 0, renewals: 0 });
  }
  const [chat, renewals] = await Promise.all([Chat.countDocuments({ adminUnread: { $gt: 0 } }), SubRequest.countDocuments({ status: "pending" })]);
  res.json({ chat, renewals });
}));

// Admin inbox. filter: chats (default, only sellers who have a conversation) | unread | all (every seller, so the admin can start a chat).
r.get("/inbox", allowRoles("admin"), wrap(async (req, res) => {
  const filter = ["chats", "unread", "all"].includes(U.qs(req.query.filter, 10)) ? U.qs(req.query.filter, 10) : "chats";
  const q = U.qs(req.query.q, 40).trim();
  const sf = {}; if (q) { const rx = new RegExp(U.esc(q), "i"); sf.$or = [{ name: rx }, { slug: rx }]; }
  const pick = "name slug status category subscription";
  let items, data;
  if (filter === "all") {
    data = await U.paged(Store, sf, { page: req.query.page, limit: 30, sort: { name: 1 }, select: pick });
    const chats = await Chat.find({ store: { $in: data.items.map((s) => s._id) } }).lean(), cm = new Map(chats.map((c) => [String(c.store), c]));
    items = data.items.map((s) => { const c = cm.get(String(s._id)); return { store: s, unread: c?.adminUnread || 0, lastMessage: c?.lastMessage || "", lastHasImage: !!c?.lastHasImage, lastFrom: c?.lastFrom || "", lastAt: c?.lastAt || null }; });
  } else {
    const f = {}; if (q) f.store = { $in: await Store.distinct("_id", sf) };
    if (filter === "unread") f.adminUnread = { $gt: 0 };
    data = await U.paged(Chat, f, { page: req.query.page, limit: 30, sort: { lastAt: -1 }, populate: [{ path: "store", select: pick }] });
    items = data.items.filter((c) => c.store).map((c) => ({ store: c.store, unread: c.adminUnread || 0, lastMessage: c.lastMessage, lastHasImage: !!c.lastHasImage, lastFrom: c.lastFrom, lastAt: c.lastAt }));
  }
  res.json({ items, total: data.total, page: data.page, pages: data.pages });
}));

// Messages of one thread.   (no params)  latest 40   |   ?after=<id> only newer ones (polling)   |   ?before=<id> older ones ("load earlier")
// Opening the thread (anything except ?before) marks the other side's messages as read and tells them via peerSeenAt.
r.get("/messages", wrap(async (req, res) => {
  const store = await threadStore(req), role = req.user.role, me = FIELD[role], peer = FIELD[peerOf(role)];
  const chat = await Chat.findOne({ store: store._id }).lean();
  const meta = { _id: store._id, name: store.name, slug: store.slug, status: store.status, category: store.category, plan: store.subscription?.plan || "", endsAt: store.subscription?.endsAt || null };
  if (!chat) return res.json({ items: [], hasMore: false, peerSeenAt: null, store: meta });
  const after = U.qs(req.query.after, 40), before = U.qs(req.query.before, 40), limit = Math.min(60, Math.max(1, parseInt(req.query.limit) || 40));
  let rows, hasMore = false;
  if (mongoose.isValidObjectId(after)) rows = await Message.find({ chat: chat._id, _id: { $gt: after } }).sort({ _id: 1 }).limit(100).lean();
  else {
    const f = { chat: chat._id }; if (mongoose.isValidObjectId(before)) f._id = { $lt: before };
    rows = (await Message.find(f).sort({ _id: -1 }).limit(limit + 1).lean());
    hasMore = rows.length > limit; rows = rows.slice(0, limit).reverse();
  }
  if (!mongoose.isValidObjectId(before)) {
    const gotPeer = rows.some((m) => m.from !== role);
    if (chat[me.unread] > 0 || gotPeer || !mongoose.isValidObjectId(after)) {
      await Chat.updateOne({ _id: chat._id }, { $set: { [me.seen]: new Date(), [me.unread]: 0 } });
    }
  }
  res.json({ items: rows.map(view), hasMore, peerSeenAt: chat[peer.seen] || null, store: meta });
}));

r.post("/messages", upload.single("image"), wrap(async (req, res) => {
  const store = await threadStore(req), role = req.user.role, me = FIELD[role], peer = FIELD[peerOf(role)];
  const text = String(req.body.text || "").trim().slice(0, 2000);
  if (!text && !req.file) throw U.fail(400, "Type a message or choose a photo.");
  // find / create the thread (two first messages at the same moment can race on the unique index, so retry once)
  const open = () => Chat.findOneAndUpdate({ store: store._id }, { $setOnInsert: { store: store._id } }, { upsert: true, new: true });
  const chat = await open().catch((e) => { if (e.code === 11000) return open(); throw e; });
  const image = req.file ? await C.uploadPrivate(req.file, "chat") : "";
  let msg;
  try { msg = await Message.create({ chat: chat._id, store: store._id, sender: req.user._id, from: role, text, image }); }
  catch (e) { C.removePrivate(image); throw e; }
  const before = await Chat.findOneAndUpdate({ _id: chat._id },
    { $set: { lastMessage: text.slice(0, 100), lastHasImage: !!image, lastFrom: role, lastAt: msg.createdAt, [me.seen]: msg.createdAt }, $inc: { [peer.unread]: 1 } }, { new: false }).lean();
  // like WhatsApp: only the FIRST unread message rings the bell, the rest just raise the counter
  if (!before || !(before[peer.unread] > 0)) {
    const body = (text || "Sent a photo").slice(0, 120);
    if (role === "seller") U.bg(U.notifyAdmins(`Message from ${store.name}`, body, "/admin/chat?store=" + store._id));
    else U.bg(U.notify(store.owner, "Message from Orderistan", body, "/seller/chat"));
  }
  res.status(201).json({ message: view(msg) });
}));

// A chat photo: only the admin and the owner of that store may open it.
r.get("/image/:id", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "No photo." });
  const m = await Message.findById(req.params.id).select("store image");
  if (!m?.image) return res.status(404).json({ message: "No photo." });
  if (req.user.role === "seller" && !(await Store.exists({ _id: m.store, owner: req.user._id }))) return res.status(403).json({ message: "Not allowed." });
  await C.streamPrivate(res, m.image);
}));

module.exports = r;
