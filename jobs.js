const mongoose = require("mongoose");
const { Store, Product, Setting, Message, keywordsOf } = require("./models");
const C = require("./cloud");
const U = require("./utils");

// Only one pm2 worker may run a job at a time. Returns true if THIS process got the lock for `ttlMs`.
async function tryLock(name, ttlMs) {
  const col = mongoose.connection.collection("locks"), now = new Date();
  try {
    await col.findOneAndUpdate({ _id: name, expiresAt: { $lte: now } }, { $set: { expiresAt: new Date(+now + ttlMs) } }, { upsert: true });
    return true;
  } catch (e) {
    if (e.code === 11000) return false; // somebody else holds a live lock
    throw e;
  }
}

// Warns sellers 7/3/1 days before expiry and closes stores whose subscription has ended.
// Every state change is an atomic conditional update, so even if two workers ran at once nobody would be notified twice.
async function checkSubscriptions() {
  const now = new Date(); let warned = 0, expired = 0;
  const stores = await Store.find({ status: "active", "subscription.endsAt": { $lte: new Date(+now + 7 * U.DAY) } });
  for (const s of stores) {
    const end = s.subscription?.endsAt; if (!end) continue;
    if (end <= now) {
      const r = await Store.updateOne({ _id: s._id, status: "active" }, { status: "expired" });
      if (!r.modifiedCount) continue;
      await Product.updateMany({ store: s._id }, { live: false });
      expired++;
      await U.notify(s.owner, "Subscription expired", "Your store is now closed to customers. Contact Orderistan to renew.", "/seller");
      await U.notifyAdmins("Subscription expired", `${s.name} (${s.slug}) has expired.`, "/admin/sellers");
      await U.log({ ip: "system" }, "subscription.expired", { store: s.slug }, { store: s._id });
      continue;
    }
    const left = Math.ceil((end - now) / U.DAY);
    const t = [1, 3, 7].find((x) => left <= x);
    const done = s.subscription.notified || [];
    if (t && !done.includes(t)) {
      const next = [...new Set([...done, ...[1, 3, 7].filter((x) => x >= t)])];
      const r = await Store.updateOne({ _id: s._id, "subscription.notified": { $ne: t } }, { $set: { "subscription.notified": next } });
      if (!r.modifiedCount) continue;
      warned++;
      const msg = `Your store subscription ends in ${left} day${left > 1 ? "s" : ""} (${end.toDateString()}). Renew to stay online.`;
      await U.notify(s.owner, "Subscription ending soon", msg, "/seller");
      await U.notifyAdmins("Subscription ending soon", `${s.name} (${s.slug}): ${left} day(s) left.`, "/admin/sellers");
      await U.log({ ip: "system" }, "subscription.warning", { store: s.slug, left }, { store: s._id });
    }
  }
  return { warned, expired };
}

// Warns the owner when Cloudinary usage first crosses 70 / 85 / 95 %. The highest level already announced is remembered, so nobody is spammed;
// it is reset when usage falls back under 70 % (a new billing month).
const LEVELS = [95, 85, 70];
async function checkCloudinary() {
  const u = await C.usage(true); if (u.percent == null) return { level: 0 };
  const level = LEVELS.find((l) => u.percent >= l) || 0;
  const prev = (await Setting.findById("cloudAlert").lean())?.value || 0;
  if (level > prev) await U.notifyAdmins(`Cloudinary usage at ${level}%`, `Image storage plan usage is ${u.percent.toFixed(1)}%. Review the Cloudinary page before uploads stop working.`, "/admin/cloudinary");
  if (level !== prev) await Setting.updateOne({ _id: "cloudAlert" }, { value: level }, { upsert: true });
  return { level, percent: u.percent };
}

// Support-chat history is kept for 120 days; the private photos are deleted from Cloudinary with their messages (saves storage credits).
async function pruneChat() {
  const cutoff = new Date(Date.now() - 120 * U.DAY); let photos = 0;
  for (;;) {
    const old = await Message.find({ createdAt: { $lt: cutoff }, image: { $ne: "" } }).select("image").limit(200).lean();
    if (!old.length) break;
    old.forEach((m) => C.removePrivate(m.image)); photos += old.length;
    await Message.deleteMany({ _id: { $in: old.map((m) => m._id) } });
  }
  const r = await Message.deleteMany({ createdAt: { $lt: cutoff } });
  return { photos, messages: r.deletedCount || 0 };
}

// One-time data upgrade for databases created before `Product.live` and `Product.keywords` existed. Safe to run on every start.
async function backfill() {
  if (await Product.exists({ live: { $exists: false } })) {
    const now = new Date();
    const live = (await Store.find({ status: "active", "subscription.endsAt": { $gt: now } }).select("_id").lean()).map((s) => s._id);
    await Product.updateMany({ store: { $in: live } }, { live: true });
    await Product.updateMany({ store: { $nin: live } }, { live: false });
    console.log("backfill: Product.live set");
  }
  for (;;) {
    const batch = await Product.find({ keywords: { $exists: false } }).select("name").limit(500).lean();
    if (!batch.length) break;
    await Product.bulkWrite(batch.map((p) => ({ updateOne: { filter: { _id: p._id }, update: { $set: { keywords: keywordsOf(p.name) } } } })));
    console.log(`backfill: search keywords set for ${batch.length} products`);
  }
}

function start() {
  const EVERY = 10 * 60 * 1000; // 10 min keeps the marketplace "live" flag close to the real expiry time
  const run = async () => {
    try { if (await tryLock("subscriptions", EVERY - 30 * 1000)) await checkSubscriptions(); }
    catch (e) { console.error("subscription check failed:", e.message); }
  };
  run(); setInterval(run, EVERY).unref();
  const cloud = async () => { try { if (await tryLock("cloudinary", 55 * 60 * 1000)) await checkCloudinary(); } catch (e) { console.error("cloudinary check failed:", e.message); } };
  const prune = async () => { try { if (await tryLock("chatPrune", 23 * 3600 * 1000)) await pruneChat(); } catch (e) { console.error("chat prune failed:", e.message); } };
  setTimeout(prune, 90000).unref(); setInterval(prune, 24 * 3600 * 1000).unref();
  // health-check heartbeat: a real ping every 5 min, remembered so "last successful health check" is meaningful even when nobody has the dashboard open
  const beat = async () => { try { if (await tryLock("dbHeartbeat", 4.5 * 60 * 1000)) await require("./sysmonitor").probe({ persist: true }); } catch (e) { console.error("db heartbeat failed:", e.message); } };
  setTimeout(beat, 20000).unref(); setInterval(beat, 5 * 60 * 1000).unref();
  setTimeout(cloud, 30000).unref(); setInterval(cloud, 60 * 60 * 1000).unref();
}
module.exports = { checkSubscriptions, checkCloudinary, pruneChat, backfill, start };
